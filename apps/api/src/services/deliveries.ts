import type {
  DeliveryDetail,
  DeliveryListItem,
  DeliveryListResponse,
  EndpointStats,
  ListDeliveriesQuery,
} from "@repo/shared/delivery";
import { AppError, notFound } from "../lib/errors.js";
import {
  endpointStats,
  getDelivery,
  listDeliveries,
  type DeliveryDetailRow,
  type ListedDelivery,
} from "./delivery/queries.js";
import { replayDelivery } from "./delivery/repository.js";
import { activePause, successRate } from "./delivery/stats.js";

// puts an exhausted delivery back in the queue with a fresh set of attempts. another
// organization's delivery is reported as missing, same as an unknown id
export async function replayExhaustedDelivery(organizationId: string, deliveryId: string): Promise<void> {
  const result = await replayDelivery(organizationId, deliveryId);
  switch (result.kind) {
    case "replayed":
      return;
    case "not_found":
      throw notFound("delivery not found");
    case "not_replayable":
      throw new AppError("delivery_not_replayable", "only an exhausted delivery can be replayed");
    case "endpoint_inactive":
      throw new AppError("endpoint_inactive", "the endpoint is disabled or deleted, enable it before replaying");
  }
}

// fields are copied one by one on purpose, the response only has what the schema names
function toListItem(row: ListedDelivery): DeliveryListItem {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    endpointId: row.endpointId,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    lastAttempt: row.lastAttempt,
  };
}

export async function listDeliveryPage(
  organizationId: string,
  query: ListDeliveriesQuery,
): Promise<DeliveryListResponse> {
  const page = await listDeliveries(organizationId, query);
  return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
}

function toDetail(row: DeliveryDetailRow): DeliveryDetail {
  const last = row.attempts.at(-1);
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.event.type,
    endpointId: row.endpointId,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    lastAttempt: last ? { responseStatus: last.responseStatus, error: last.error } : null,
    event: {
      id: row.event.eventId,
      type: row.event.type,
      occurredAt: row.event.occurredAt.toISOString(),
      receivedAt: row.event.receivedAt.toISOString(),
      payload: row.event.payload as DeliveryDetail["event"]["payload"],
    },
    attempts: row.attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      startedAt: attempt.startedAt.toISOString(),
      durationMs: attempt.durationMs,
      responseStatus: attempt.responseStatus,
      error: attempt.error,
    })),
  };
}

export async function getDeliveryDetail(organizationId: string, deliveryId: string): Promise<DeliveryDetail> {
  const row = await getDelivery(organizationId, deliveryId);
  if (!row) throw notFound("delivery not found");
  return toDetail(row);
}

export async function getEndpointStats(organizationId: string, endpointId: string): Promise<EndpointStats> {
  const now = new Date();
  const stats = await endpointStats(organizationId, endpointId, now);
  if (!stats) throw notFound("webhook endpoint not found");
  const { pending, inProgress, succeeded, exhausted } = stats.counts;
  return {
    window: "24h",
    total: pending + inProgress + succeeded + exhausted,
    pending,
    inProgress,
    succeeded,
    exhausted,
    successRate: successRate(succeeded, exhausted),
    pausedUntil: activePause(stats.pausedUntil, now)?.toISOString() ?? null,
  };
}
