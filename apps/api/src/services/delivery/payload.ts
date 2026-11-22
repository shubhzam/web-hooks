import { createHmac } from "node:crypto";

// pure: the request body and its standard webhooks signature

const SECRET_PREFIX = "whsec_";

export interface EventRow {
  eventId: string;
  type: string;
  occurredAt: Date;
  payload: unknown;
}

// serialized exactly once, the signature covers these exact bytes
export function buildBody(event: EventRow): string {
  return JSON.stringify({
    eventId: event.eventId,
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    data: event.payload,
  });
}

// key is the base64 decoded part after whsec_, signed text is "{id}.{timestamp}.{body}"
export function signPayload(deliveryId: string, timestampSeconds: number, body: string, secret: string): string {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = Buffer.from(encoded, "base64");
  const signature = createHmac("sha256", key).update(`${deliveryId}.${timestampSeconds}.${body}`).digest("base64");
  return `v1,${signature}`;
}
