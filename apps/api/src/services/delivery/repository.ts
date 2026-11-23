import { uuidv7 } from "uuidv7";
import { config } from "../../config.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { EventRow } from "./payload.js";
import { positionOf } from "./retry.js";

export interface ClaimedDelivery {
  id: string;
  eventId: string;
  endpointId: string;
  // the attempt number this claim represents, and the fence for the outcome write
  attemptCount: number;
  // attempt_count at the last replay, the retry position is attempt_count minus this
  replayBase: number;
}

export interface DeliveryContext {
  deliveryId: string;
  event: EventRow;
  cycleStartedAt: Date;
  endpoint: { url: string; signingSecret: string; status: string; deletedAt: Date | null; pausedUntil: Date | null };
}

export type Outcome = "succeeded" | "exhausted" | "retry";

export type WriteResult = "recorded" | "lease_lost";

export interface AttemptFields {
  startedAt: Date;
  durationMs: number | null;
  responseStatus: number | null;
  error: string | null;
}

// a retry carries the time of the next attempt, the other outcomes are final
export type Verdict = { outcome: "succeeded" | "exhausted" } | { outcome: "retry"; nextAttemptAt: Date };

export type OutcomeRecord = AttemptFields & Verdict & { deliveryId: string; attemptNumber: number };

export interface TripResult {
  pausedUntil: Date;
  deferred: number;
}

export type ReplayResult =
  | { kind: "replayed" }
  | { kind: "not_found" }
  | { kind: "not_replayable" }
  | { kind: "endpoint_inactive" };

export interface ReapResult {
  requeued: number;
  exhausted: number;
}

interface ClaimedRow {
  id: string;
  event_id: string;
  endpoint_id: string;
  attempt_count: number;
  replay_base: number;
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
  paused_until: Date | null;
  cycle_started_at: Date;
}

interface ExpiredRow {
  id: string;
  attempt_count: number;
  replay_base: number;
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
    RETURNING d.id, d.event_id, d.endpoint_id, d.attempt_count, d.replay_base`;
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    attemptCount: row.attempt_count,
    replayBase: row.replay_base,
  }));
}

// one query for the whole claimed batch, keyed by delivery id
export async function loadContext(claimed: ClaimedDelivery[]): Promise<Map<string, DeliveryContext>> {
  const ids = claimed.map((delivery) => delivery.id);
  const rows = await prisma.$queryRaw<ContextRow[]>`
    SELECT d.id AS delivery_id, e.event_id, e.type, e.occurred_at, e.payload,
           d.cycle_started_at, w.url, w.signing_secret, w.status::text AS endpoint_status, w.deleted_at, w.paused_until
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
        cycleStartedAt: row.cycle_started_at,
        endpoint: {
          url: row.url,
          signingSecret: row.signing_secret,
          status: row.endpoint_status,
          deletedAt: row.deleted_at,
          pausedUntil: row.paused_until,
        },
      },
    ]),
  );
}

// the fence: the update only matches while this worker still owns the attempt
function applyOutcome(tx: Prisma.TransactionClient, record: OutcomeRecord): Promise<number> {
  if (record.outcome === "retry") {
    return tx.$executeRaw`
      UPDATE deliveries
      SET status = 'pending', next_attempt_at = ${record.nextAttemptAt}::timestamptz, lease_expires_at = NULL
      WHERE id = ${record.deliveryId}::uuid AND status = 'in_progress' AND attempt_count = ${record.attemptNumber}`;
  }
  return tx.$executeRaw`
    UPDATE deliveries
    SET status = ${record.outcome}::delivery_status, completed_at = now(), lease_expires_at = NULL
    WHERE id = ${record.deliveryId}::uuid AND status = 'in_progress' AND attempt_count = ${record.attemptNumber}`;
}

// the fenced update and the attempt row commit together or not at all. a worker that lost its
// lease writes nothing
export async function recordOutcome(record: OutcomeRecord): Promise<WriteResult> {
  try {
    await prisma.$transaction(
      async (tx) => {
        if ((await applyOutcome(tx, record)) === 0) throw new LeaseLost();
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

// gives a claimed delivery back without spending the attempt: no attempt row, and attempt_count
// goes back down so the next claim reuses the number. same fence as recordOutcome
export async function releaseDelivery(deliveryId: string, attemptNumber: number, notBefore: Date): Promise<WriteResult> {
  const touched = await prisma.$executeRaw`
    UPDATE deliveries
    SET status = 'pending', attempt_count = attempt_count - 1, next_attempt_at = ${notBefore}::timestamptz, lease_expires_at = NULL
    WHERE id = ${deliveryId}::uuid AND status = 'in_progress' AND attempt_count = ${attemptNumber}`;
  return touched === 0 ? "lease_lost" : "recorded";
}

// takes deliveries whose lease ran out. the lost attempt is written down, and the delivery goes
// back to pending unless it has used all its attempts
export async function reapExpired(): Promise<ReapResult> {
  return prisma.$transaction(
    async (tx) => {
      const expired = await tx.$queryRaw<ExpiredRow[]>`
        SELECT id, attempt_count, replay_base, lease_expires_at FROM deliveries
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

      // lease expiries and failed attempts draw from the same budget
      const hasBudget = (row: ExpiredRow) => positionOf(row.attempt_count, row.replay_base) < config.deliveryMaxAttempts;
      const requeueIds = expired.filter(hasBudget).map((row) => row.id);
      const exhaustIds = expired.filter((row) => !hasBudget(row)).map((row) => row.id);
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

// the breaker trip, in one transaction. only the caller whose update matches a row gets a result,
// it is the one that moves the endpoint's waiting deliveries to after the pause, each at a random
// point in the spread window so they do not all go out in the same second
export async function tripBreaker(endpointId: string): Promise<TripResult | null> {
  return prisma.$transaction(
    async (tx) => {
      const paused = await tx.$queryRaw<{ paused_until: Date }[]>`
        UPDATE webhook_endpoints
        SET paused_until = now() + (${config.circuitCooldownMs}::double precision * interval '1 millisecond')
        WHERE id = ${endpointId}::uuid AND (paused_until IS NULL OR paused_until < now())
        RETURNING paused_until`;
      const pausedUntil = paused[0]?.paused_until;
      if (!pausedUntil) return null;
      const deferred = await tx.$executeRaw`
        UPDATE deliveries
        SET next_attempt_at = ${pausedUntil}::timestamptz
          + (random() * ${config.circuitReleaseSpreadMs}::double precision) * interval '1 millisecond'
        WHERE endpoint_id = ${endpointId}::uuid AND status = 'pending' AND next_attempt_at < ${pausedUntil}::timestamptz`;
      return { pausedUntil, deferred };
    },
    { timeout: config.deliveryTxTimeoutMs, maxWait: config.deliveryTxMaxWaitMs },
  );
}

// scoped to the organization, so another organization's delivery looks like a missing one. the
// last step is one guarded update: if two replays race, only one of them touches the row
export async function replayDelivery(organizationId: string, deliveryId: string): Promise<ReplayResult> {
  const delivery = await prisma.delivery.findFirst({
    where: { id: deliveryId, organizationId },
    select: { status: true, endpoint: { select: { status: true, deletedAt: true } } },
  });
  if (!delivery) return { kind: "not_found" };
  if (delivery.status !== "exhausted") return { kind: "not_replayable" };
  if (delivery.endpoint.status !== "active" || delivery.endpoint.deletedAt !== null) return { kind: "endpoint_inactive" };
  const touched = await prisma.$executeRaw`
    UPDATE deliveries
    SET status = 'pending', next_attempt_at = now(), replay_base = attempt_count,
        cycle_started_at = now(), completed_at = NULL, lease_expires_at = NULL
    WHERE id = ${deliveryId}::uuid AND status = 'exhausted'`;
  return touched === 0 ? { kind: "not_replayable" } : { kind: "replayed" };
}
