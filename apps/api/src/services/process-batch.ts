import type { EventEnvelope } from "@repo/shared/event";
import { config } from "../config.js";
import type { Prisma } from "../generated/prisma/client.js";
import { publishRaw } from "../lib/kafka.js";
import { prisma } from "../lib/prisma.js";
import {
  buildDeliveryRows,
  chunk,
  dedupeByEventId,
  distinctPairs,
  matchEndpoints,
  pairKey,
  parseMessage,
  type DeliveryRow,
  type EndpointRef,
  type EventPair,
  type SourceMessage,
} from "./fanout.js";

export interface BatchResult {
  events: number;
  deliveries: number;
  poison: number;
}

interface PoisonMessage {
  message: SourceMessage;
  error: string;
}

function classify(messages: SourceMessage[]): { envelopes: EventEnvelope[]; poison: PoisonMessage[] } {
  const envelopes: EventEnvelope[] = [];
  const poison: PoisonMessage[] = [];
  for (const message of messages) {
    const parsed = parseMessage(message.value);
    if (parsed.ok) envelopes.push(parsed.envelope);
    else poison.push({ message, error: parsed.error });
  }
  return { envelopes, poison };
}

async function insertEvents(tx: Prisma.TransactionClient, envelopes: EventEnvelope[]): Promise<number> {
  const { count } = await tx.event.createMany({
    data: envelopes.map((envelope) => ({
      eventId: envelope.eventId,
      organizationId: envelope.organizationId,
      type: envelope.type,
      payload: envelope.payload,
      occurredAt: new Date(envelope.occurredAt),
      receivedAt: new Date(envelope.receivedAt),
    })),
    // on conflict do nothing, so a replayed or duplicated event id is skipped
    skipDuplicates: true,
  });
  return count;
}

// one query per distinct (organization, type) pair, never per event. the created_at rule is
// applied later in code because received_at is different for every event
async function loadEndpoints(
  tx: Prisma.TransactionClient,
  pairs: EventPair[],
): Promise<Map<string, EndpointRef[]>> {
  const endpointsByPair = new Map<string, EndpointRef[]>();
  for (const pair of pairs) {
    const endpoints = await tx.webhookEndpoint.findMany({
      where: {
        organizationId: pair.organizationId,
        status: "active",
        deletedAt: null,
        eventTypes: { some: { eventType: pair.type } },
      },
      select: { id: true, createdAt: true },
    });
    endpointsByPair.set(pairKey(pair), endpoints);
  }
  return endpointsByPair;
}

function planDeliveries(envelopes: EventEnvelope[], endpointsByPair: Map<string, EndpointRef[]>): DeliveryRow[] {
  return envelopes.flatMap((envelope) => {
    const forPair = endpointsByPair.get(pairKey(envelope)) ?? [];
    return buildDeliveryRows(envelope, matchEndpoints(envelope, forPair));
  });
}

async function insertDeliveries(tx: Prisma.TransactionClient, rows: DeliveryRow[]): Promise<number> {
  let inserted = 0;
  for (const part of chunk(rows, config.deliveryChunkSize)) {
    // on conflict do nothing against the unique (event_id, endpoint_id)
    const { count } = await tx.delivery.createMany({ data: part, skipDuplicates: true });
    inserted += count;
  }
  return inserted;
}

// events, matching and deliveries commit together or not at all
async function persist(envelopes: EventEnvelope[]): Promise<{ events: number; deliveries: number }> {
  return prisma.$transaction(
    async (tx) => {
      const events = await insertEvents(tx, envelopes);
      const endpointsByPair = await loadEndpoints(tx, distinctPairs(envelopes));
      const deliveries = await insertDeliveries(tx, planDeliveries(envelopes, endpointsByPair));
      return { events, deliveries };
    },
    { timeout: config.processorTxTimeoutMs, maxWait: config.processorTxMaxWaitMs },
  );
}

// the original bytes go over untouched, the headers say why and where it came from
async function sendToDlq(poison: PoisonMessage[]): Promise<void> {
  await Promise.all(
    poison.map(({ message, error }) =>
      publishRaw(config.kafkaDlqTopic, {
        key: message.key,
        value: message.value,
        headers: {
          error,
          "source-topic": message.topic,
          "source-partition": String(message.partition),
          "source-offset": message.offset,
        },
      }),
    ),
  );
}

// throws on any database or dlq failure, the caller retries the whole batch. every write is
// idempotent, so a retry or a replay after a crash cannot create a second row
export async function processBatch(messages: SourceMessage[]): Promise<BatchResult> {
  const { envelopes, poison } = classify(messages);
  const unique = dedupeByEventId(envelopes);
  const saved = unique.length > 0 ? await persist(unique) : { events: 0, deliveries: 0 };
  // after the commit, so a failed transaction never leaves copies behind in the dlq
  await sendToDlq(poison);
  return { ...saved, poison: poison.length };
}
