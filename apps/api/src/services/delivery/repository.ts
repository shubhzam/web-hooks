import { uuidv7 } from "uuidv7";
import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import type { EventRow } from "./payload.js";

export interface ClaimedDelivery {
  id: string;
  eventId: string;
  endpointId: string;
  // the attempt number this claim represents, and the fence for the outcome write
  attemptCount: number;
}

export interface DeliveryContext {
  deliveryId: string;
  event: EventRow;
  endpoint: { url: string; signingSecret: string; status: string; deletedAt: Date | null };
}

export type Outcome = "succeeded" | "exhausted";

export interface OutcomeRecord {
  deliveryId: string;
  attemptNumber: number;
  outcome: Outcome;
  startedAt: Date;
  durationMs: number | null;
  responseStatus: number | null;
  error: string | null;
}

export interface ReapResult {
  requeued: number;
  exhausted: number;
}

interface ClaimedRow {
  id: string;
  event_id: string;
  endpoint_id: string;
  attempt_count: number;
}

interface ContextRow {
  delivery_id: string;
  event_id: string;
  type: string;
  occurred_at: Date;
  payload: unknown;
  url: string;
  signing_secret: string;
  endpoint_status: string;
  deleted_at: Date | null;
}

interface ExpiredRow {
  id: string;
  attempt_count: number;
  lease_expires_at: Date;
}

// thrown inside the outcome transaction to roll it back when the fence does not match
class LeaseLost extends Error {}

// one statement: pick ready rows, skip rows another worker has locked, and take them. workers
// never wait on each other and never get the same row
export async function claimDeliveries(limit: number): Promise<ClaimedDelivery[]> {
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    WITH ready AS (
      SELECT id FROM deliveries
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE deliveries d
    SET status = 'in_progress',
        attempt_count = d.attempt_count + 1,
        lease_expires_at = now() + (${config.deliveryLeaseMs}::double precision * interval '1 millisecond')
    FROM ready
    WHERE d.id = ready.id
    RETURNING d.id, d.event_id, d.endpoint_id, d.attempt_count`;
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    attemptCount: row.attempt_count,
  }));
}

// one query for the whole claimed batch, keyed by delivery id
export async function loadContext(claimed: ClaimedDelivery[]): Promise<Map<string, DeliveryContext>> {
  const ids = claimed.map((delivery) => delivery.id);
  const rows = await prisma.$queryRaw<ContextRow[]>`
    SELECT d.id AS delivery_id, e.event_id, e.type, e.occurred_at, e.payload,
           w.url, w.signing_secret, w.status::text AS endpoint_status, w.deleted_at
    FROM deliveries d
    JOIN events e ON e.event_id = d.event_id
    JOIN webhook_endpoints w ON w.id = d.endpoint_id
    WHERE d.id = ANY(${ids}::uuid[])`;
  return new Map(
    rows.map((row) => [
      row.delivery_id,
      {
        deliveryId: row.delivery_id,
        event: { eventId: row.event_id, type: row.type, occurredAt: row.occurred_at, payload: row.payload },
        endpoint: {
          url: row.url,
          signingSecret: row.signing_secret,
          status: row.endpoint_status,
          deletedAt: row.deleted_at,
        },
      },
    ]),
  );
}

// the fenced update and the attempt row commit together or not at all. the update only matches
// while this worker still owns the attempt, so a worker that lost its lease writes nothing
export async function recordOutcome(record: OutcomeRecord): Promise<"recorded" | "lease_lost"> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const touched = await tx.$executeRaw`
          UPDATE deliveries
          SET status = ${record.outcome}::delivery_status, completed_at = now(), lease_expires_at = NULL
          WHERE id = ${record.deliveryId}::uuid AND status = 'in_progress' AND attempt_count = ${record.attemptNumber}`;
        if (touched === 0) throw new LeaseLost();
        await tx.deliveryAttempt.create({
          data: {
            id: uuidv7(),
            deliveryId: record.deliveryId,
            attemptNumber: record.attemptNumber,
            startedAt: record.startedAt,
            durationMs: record.durationMs,
            responseStatus: record.responseStatus,
            error: record.error,
          },
        });
      },
      { timeout: config.deliveryTxTimeoutMs, maxWait: config.deliveryTxMaxWaitMs },
    );
    return "recorded";
  } catch (err) {
    if (err instanceof LeaseLost) return "lease_lost";
    throw err;
  }
}

// takes deliveries whose lease ran out. the lost attempt is written down, and the delivery goes
// back to pending unless it has used all its attempts
export async function reapExpired(): Promise<ReapResult> {
  return prisma.$transaction(
    async (tx) => {
      const expired = await tx.$queryRaw<ExpiredRow[]>`
        SELECT id, attempt_count, lease_expires_at FROM deliveries
        WHERE status = 'in_progress' AND lease_expires_at < now()
        ORDER BY lease_expires_at
        LIMIT ${config.deliveryReapBatchSize}
        FOR UPDATE SKIP LOCKED`;
      if (expired.length === 0) return { requeued: 0, exhausted: 0 };

      await tx.deliveryAttempt.createMany({
        data: expired.map((row) => ({
          id: uuidv7(),
          deliveryId: row.id,
          attemptNumber: row.attempt_count,
          startedAt: new Date(row.lease_expires_at.getTime() - config.deliveryLeaseMs),
          error: "lease_expired",
        })),
        // on conflict do nothing, the attempt may already be written
        skipDuplicates: true,
      });

      const requeueIds = expired.filter((row) => row.attempt_count < config.deliveryMaxAttempts).map((row) => row.id);
      const exhaustIds = expired.filter((row) => row.attempt_count >= config.deliveryMaxAttempts).map((row) => row.id);
      await tx.$executeRaw`
        UPDATE deliveries SET status = 'pending', next_attempt_at = now(), lease_expires_at = NULL
        WHERE id = ANY(${requeueIds}::uuid[])`;
      await tx.$executeRaw`
        UPDATE deliveries SET status = 'exhausted', completed_at = now(), lease_expires_at = NULL
        WHERE id = ANY(${exhaustIds}::uuid[])`;
      return { requeued: requeueIds.length, exhausted: exhaustIds.length };
    },
    { timeout: config.deliveryTxTimeoutMs, maxWait: config.deliveryTxMaxWaitMs },
  );
}
