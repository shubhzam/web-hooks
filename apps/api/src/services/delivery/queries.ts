import type { DeliveryStatus, ListDeliveriesQuery } from "@repo/shared/delivery";
import { config } from "../../config.js";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { uuidv7LowerBound } from "../../lib/uuidv7-bound.js";

// the read side of the dashboard. every query is scoped by organization_id, so another
// organization's rows are never returned and look the same as rows that do not exist

export interface ListedDelivery {
  id: string;
  eventId: string;
  eventType: string;
  endpointId: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  createdAt: Date;
  completedAt: Date | null;
  lastAttempt: { responseStatus: number | null; error: string | null } | null;
}

export interface DeliveryPage {
  items: ListedDelivery[];
  nextCursor: string | null;
}

export type DeliveryDetailRow = Prisma.DeliveryGetPayload<{ include: { event: true; attempts: true } }>;

export interface StatusCounts {
  pending: number;
  inProgress: number;
  succeeded: number;
  exhausted: number;
}

export interface EndpointStatsRow {
  counts: StatusCounts;
  pausedUntil: Date | null;
}

interface ListRow {
  id: string;
  event_id: string;
  event_type: string;
  endpoint_id: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: Date;
  created_at: Date;
  completed_at: Date | null;
  has_attempt: boolean;
  response_status: number | null;
  error: string | null;
}

interface CountRow {
  status: DeliveryStatus;
  count: bigint;
}

function listConditions(organizationId: string, query: ListDeliveriesQuery): Prisma.Sql[] {
  const conditions = [Prisma.sql`d.organization_id = ${organizationId}::uuid`];
  if (query.cursor) conditions.push(Prisma.sql`d.id < ${query.cursor}::uuid`);
  if (query.endpointId) conditions.push(Prisma.sql`d.endpoint_id = ${query.endpointId}::uuid`);
  if (query.status) conditions.push(Prisma.sql`d.status = ${query.status}::delivery_status`);
  if (query.eventType) conditions.push(Prisma.sql`e.type = ${query.eventType}`);
  return conditions;
}

// newest first by id, ids are uuidv7 so that is creation order. the last attempt comes from a
// lateral lookup that reads one row of the (delivery_id, attempt_number) index per delivery.
// exported so the smoke script can run explain on exactly this statement
export function listQuery(organizationId: string, query: ListDeliveriesQuery): Prisma.Sql {
  const where = Prisma.join(listConditions(organizationId, query), " AND ");
  // one extra row tells us whether there is a next page
  const fetchCount = query.limit + 1;
  return Prisma.sql`
    SELECT d.id, d.event_id, e.type AS event_type, d.endpoint_id, d.status::text AS status,
           d.attempt_count, d.next_attempt_at, d.created_at, d.completed_at,
           (la.attempt_number IS NOT NULL) AS has_attempt, la.response_status, la.error
    FROM deliveries d
    JOIN events e ON e.event_id = d.event_id
    LEFT JOIN LATERAL (
      SELECT a.attempt_number, a.response_status, a.error
      FROM delivery_attempts a
      WHERE a.delivery_id = d.id
      ORDER BY a.attempt_number DESC
      LIMIT 1
    ) la ON true
    WHERE ${where}
    ORDER BY d.id DESC
    LIMIT ${fetchCount}`;
}

function toListed(row: ListRow): ListedDelivery {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    endpointId: row.endpoint_id,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    lastAttempt: row.has_attempt ? { responseStatus: row.response_status, error: row.error } : null,
  };
}

export async function listDeliveries(organizationId: string, query: ListDeliveriesQuery): Promise<DeliveryPage> {
  const rows = await prisma.$queryRaw<ListRow[]>(listQuery(organizationId, query));
  const items = rows.slice(0, query.limit).map(toListed);
  return { items, nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null };
}

export async function getDelivery(organizationId: string, deliveryId: string): Promise<DeliveryDetailRow | null> {
  return prisma.delivery.findFirst({
    where: { id: deliveryId, organizationId },
    include: { event: true, attempts: { orderBy: { attemptNumber: "asc" } } },
  });
}

// counts by status for the window. the lower bound on id stands in for a created_at filter, ids
// are uuidv7 so everything created inside the window sorts at or above it. exported for explain
export function statsQuery(organizationId: string, endpointId: string, windowStart: Date): Prisma.Sql {
  const lowerBound = uuidv7LowerBound(windowStart);
  return Prisma.sql`
    SELECT status::text AS status, count(*) AS count
    FROM deliveries
    WHERE endpoint_id = ${endpointId}::uuid
      AND organization_id = ${organizationId}::uuid
      AND id >= ${lowerBound}::uuid
    GROUP BY status`;
}

function toCounts(rows: CountRow[]): StatusCounts {
  const counts: StatusCounts = { pending: 0, inProgress: 0, succeeded: 0, exhausted: 0 };
  for (const row of rows) {
    const count = Number(row.count);
    if (row.status === "pending") counts.pending = count;
    else if (row.status === "in_progress") counts.inProgress = count;
    else if (row.status === "succeeded") counts.succeeded = count;
    else counts.exhausted = count;
  }
  return counts;
}

// null when the endpoint is not in the organization, or was deleted
export async function endpointStats(
  organizationId: string,
  endpointId: string,
  now: Date,
): Promise<EndpointStatsRow | null> {
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, organizationId, deletedAt: null },
    select: { pausedUntil: true },
  });
  if (!endpoint) return null;
  const windowStart = new Date(now.getTime() - config.deliveryStatsWindowMs);
  const rows = await prisma.$queryRaw<CountRow[]>(statsQuery(organizationId, endpointId, windowStart));
  return { counts: toCounts(rows), pausedUntil: endpoint.pausedUntil };
}
