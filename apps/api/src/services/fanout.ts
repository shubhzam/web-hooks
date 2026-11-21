import { uuidv7 } from "uuidv7";
import { eventEnvelopeSchema, type EventEnvelope } from "@repo/shared/event";

// everything in this file is pure: no database, no kafka, so it can be tested with plain values

const MAX_ERROR_LENGTH = 200;

// where a message came from, kept so a poison message can point back at its source
export interface SourceMessage {
  topic: string;
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
}

export type ParseResult = { ok: true; envelope: EventEnvelope } | { ok: false; error: string };

export interface EndpointRef {
  id: string;
  createdAt: Date;
}

export interface DeliveryRow {
  id: string;
  eventId: string;
  endpointId: string;
  organizationId: string;
}

export interface EventPair {
  organizationId: string;
  type: string;
}

// postgres jsonb refuses the null character, so such a payload can never be stored. left alone it
// would look like a database error and be retried forever, so it is treated as poison instead
function containsNullCharacter(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNullCharacter);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => key.includes("\u0000") || containsNullCharacter(item));
  }
  return false;
}

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { ok: false };
  }
}

// the error text is short and carries no payload values, it ends up in a dlq header
export function parseMessage(bytes: Buffer | null): ParseResult {
  if (bytes === null) return { ok: false, error: "empty message" };
  const json = parseJson(bytes);
  if (!json.ok) return { ok: false, error: "invalid json" };
  const parsed = eventEnvelopeSchema.safeParse(json.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "envelope";
    return { ok: false, error: `invalid envelope: ${where}: ${issue?.message ?? "unknown"}`.slice(0, MAX_ERROR_LENGTH) };
  }
  if (containsNullCharacter(parsed.data.payload)) {
    return { ok: false, error: "payload contains a null character" };
  }
  return { ok: true, envelope: parsed.data };
}

// the first copy of an event id wins, which is also what the primary key does in the database
export function dedupeByEventId(envelopes: EventEnvelope[]): EventEnvelope[] {
  const seen = new Set<string>();
  return envelopes.filter((envelope) => {
    if (seen.has(envelope.eventId)) return false;
    seen.add(envelope.eventId);
    return true;
  });
}

export function pairKey(pair: EventPair): string {
  return `${pair.organizationId}:${pair.type}`;
}

export function distinctPairs(envelopes: EventEnvelope[]): EventPair[] {
  const pairs = new Map<string, EventPair>();
  for (const { organizationId, type } of envelopes) {
    pairs.set(pairKey({ organizationId, type }), { organizationId, type });
  }
  return [...pairs.values()];
}

// the pair query already filtered org, status, deletion and type. what is left is the time rule:
// an endpoint registered after the event arrived never receives it, even on a replay
export function matchEndpoints(envelope: EventEnvelope, endpointsForPair: EndpointRef[]): EndpointRef[] {
  const receivedAt = Date.parse(envelope.receivedAt);
  return endpointsForPair.filter((endpoint) => endpoint.createdAt.getTime() <= receivedAt);
}

export function buildDeliveryRows(envelope: EventEnvelope, matched: EndpointRef[]): DeliveryRow[] {
  return matched.map((endpoint) => ({
    id: uuidv7(),
    eventId: envelope.eventId,
    endpointId: endpoint.id,
    organizationId: envelope.organizationId,
  }));
}

export function chunk<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    chunks.push(rows.slice(start, start + size));
  }
  return chunks;
}
