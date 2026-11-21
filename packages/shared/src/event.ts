import * as z from "zod";
import { eventTypeSchema } from "./webhook-endpoint.js";

// pure js on purpose, feature 3 reuses these schemas at the consumer boundary

// offsets are allowed, internal apps do not all run in utc
const timestampSchema = z.iso.datetime({ offset: true });
const payloadSchema = z.record(z.string(), z.json());

export const ingestEventRequestSchema = z.strictObject({
  eventId: z.uuid(),
  organizationId: z.uuid(),
  type: eventTypeSchema,
  // defaults to the receive time
  occurredAt: timestampSchema.optional(),
  payload: payloadSchema,
});

export const ingestEventResponseSchema = z.object({
  eventId: z.uuid(),
  status: z.literal("accepted"),
});

// what goes on the webhook.events topic as json
export const eventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  organizationId: z.uuid(),
  type: eventTypeSchema,
  occurredAt: timestampSchema,
  receivedAt: timestampSchema,
  payload: payloadSchema,
});

export type IngestEventRequest = z.infer<typeof ingestEventRequestSchema>;
export type IngestEventResponse = z.infer<typeof ingestEventResponseSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
