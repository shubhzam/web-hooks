import * as z from "zod";
import { eventTypeSchema } from "./webhook-endpoint.js";

// this file is reused by the web app, so keep it pure js: no node imports

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// a replayed delivery goes back to pending, the worker picks it up from there
export const replayDeliveryResponseSchema = z.object({
  deliveryId: z.uuid(),
  status: z.literal("pending"),
});

// the values of the delivery_status enum in schema.prisma, check:dashboard compares the two
export const deliveryStatusSchema = z.enum(["pending", "in_progress", "succeeded", "exhausted"]);

export const listDeliveriesQuerySchema = z.object({
  endpointId: z.uuid().optional(),
  status: deliveryStatusSchema.optional(),
  eventType: eventTypeSchema.optional(),
  // the id of the last item of the previous page
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const lastAttemptSchema = z.object({
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
});

// no payload here, only the detail view carries it
export const deliveryListItemSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  eventType: z.string(),
  endpointId: z.uuid(),
  status: deliveryStatusSchema,
  attemptCount: z.number().int(),
  nextAttemptAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  lastAttempt: lastAttemptSchema.nullable(),
});

export const deliveryListResponseSchema = z.object({
  items: z.array(deliveryListItemSchema),
  nextCursor: z.uuid().nullable(),
});

export const deliveryAttemptSchema = z.object({
  attemptNumber: z.number().int(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nullable(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
});

export const deliveryEventSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  payload: z.json(),
});

export const deliveryDetailSchema = deliveryListItemSchema.extend({
  event: deliveryEventSchema,
  attempts: z.array(deliveryAttemptSchema),
});

// the window is always the last 24 hours, the label says so to the reader
export const endpointStatsSchema = z.object({
  window: z.literal("24h"),
  total: z.number().int(),
  pending: z.number().int(),
  inProgress: z.number().int(),
  succeeded: z.number().int(),
  exhausted: z.number().int(),
  // succeeded over succeeded plus exhausted, null while nothing has finished
  successRate: z.number().min(0).max(1).nullable(),
  // null unless the pause is still in the future
  pausedUntil: z.iso.datetime().nullable(),
});

export type ReplayDeliveryResponse = z.infer<typeof replayDeliveryResponseSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;
export type DeliveryListItem = z.infer<typeof deliveryListItemSchema>;
export type DeliveryListResponse = z.infer<typeof deliveryListResponseSchema>;
export type DeliveryAttempt = z.infer<typeof deliveryAttemptSchema>;
export type DeliveryDetail = z.infer<typeof deliveryDetailSchema>;
export type EndpointStats = z.infer<typeof endpointStatsSchema>;
