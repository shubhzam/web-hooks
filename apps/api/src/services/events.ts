import type { EventEnvelope, IngestEventRequest, IngestEventResponse } from "@repo/shared/event";
import { publish } from "../lib/kafka.js";

// the organization is trusted as sent, looking it up would put postgres on the hottest path
function buildEnvelope(input: IngestEventRequest, receivedAt: string): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    organizationId: input.organizationId,
    type: input.type,
    occurredAt: input.occurredAt ?? receivedAt,
    receivedAt,
    payload: input.payload,
  };
}

// resolves only after the broker acked, so a 202 means the event is durable in kafka
export async function ingestEvent(input: IngestEventRequest): Promise<IngestEventResponse> {
  await publish(buildEnvelope(input, new Date().toISOString()));
  return { eventId: input.eventId, status: "accepted" };
}
