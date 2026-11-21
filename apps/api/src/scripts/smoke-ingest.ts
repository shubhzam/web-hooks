import { randomUUID } from "node:crypto";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import * as z from "zod";
import { eventEnvelopeSchema, ingestEventResponseSchema, type EventEnvelope } from "@repo/shared/event";
import { config } from "../config.js";
import { generateApiKey } from "../services/api-keys.js";
import { SmokeFailure, check, postEvent, sleep, startTailConsumer, waitUntil, type ApiResult } from "./smoke-kit.js";

// usage: pnpm --filter api smoke:ingest (needs the api and kafka running)
// prints one line per check and exits non-zero on the first failure

const PARTITIONS = 6;
const WAIT_FOR_MESSAGE_MS = 10000;
const WARMUP_ATTEMPTS = 5;
const WARMUP_WAIT_MS = 3000;
// how long we watch for a message that must never show up
const ABSENCE_GRACE_MS = 2000;

interface Received {
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
}

const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });
const received: Received[] = [];
// event ids that were sent with a bad token or a bad body, none of them may reach the topic
const mustStayAbsent: string[] = [];

function errorCode(result: ApiResult): string {
  const parsed = errorBodySchema.safeParse(result.json);
  return parsed.success ? parsed.data.error.code : "no error body";
}

function newEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    organizationId: randomUUID(),
    type: "invoice.paid",
    payload: { invoiceId: "inv_123", amountCents: 4200, tags: ["smoke", "ingest"], nested: { ok: true } },
    ...overrides,
  };
}

function toReceived(partition: number, message: KafkaJS.KafkaMessage): Received {
  return {
    partition,
    offset: message.offset,
    key: message.key?.toString() ?? null,
    value: message.value?.toString() ?? null,
  };
}

function startConsumer(): Promise<KafkaJS.Consumer> {
  return startTailConsumer({
    clientId: "smoke-ingest",
    topic: config.kafkaTopic,
    partitions: PARTITIONS,
    onMessage: (partition, message) => received.push(toReceived(partition, message)),
  });
}

function messagesFor(eventId: string): Received[] {
  return received.filter((message) => message.key === eventId);
}

async function waitForMessages(eventId: string, count: number): Promise<Received[]> {
  await waitUntil(() => messagesFor(eventId).length >= count, WAIT_FOR_MESSAGE_MS);
  return messagesFor(eventId);
}

function parseEnvelope(message: Received | undefined): EventEnvelope | null {
  if (!message?.value) return null;
  const parsed = eventEnvelopeSchema.safeParse(JSON.parse(message.value));
  return parsed.success ? parsed.data : null;
}

// the consumer joins and positions itself asynchronously, so post canary events until one comes back.
// once a canary is seen, everything posted after it is guaranteed to be seen too
async function warmUp(): Promise<void> {
  for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt++) {
    const canary = newEvent({ type: "smoke.warmup" });
    await postEvent(canary, config.ingestApiToken);
    if (await waitUntil(() => messagesFor(canary.eventId).length > 0, WARMUP_WAIT_MS)) {
      check("the consumer sees new events", true);
      return;
    }
  }
  check("the consumer sees new events", false, `no canary after ${WARMUP_ATTEMPTS} attempts`);
}

async function checkAccepted(): Promise<void> {
  const event = newEvent();
  const before = Date.now();
  const result = await postEvent(event, config.ingestApiToken);
  const after = Date.now();
  check("valid event returns 202", result.status === 202, `got ${result.status} ${result.text}`);
  const body = ingestEventResponseSchema.parse(result.json);
  check("202 body is { eventId, status: accepted }", body.eventId === event.eventId && body.status === "accepted");

  const messages = await waitForMessages(event.eventId, 1);
  check(
    "the message is on the topic with key = eventId",
    messages.length === 1 && messages[0]?.key === event.eventId,
    `matched ${messages.length} of ${received.length} consumed`,
  );
  const envelope = parseEnvelope(messages[0]);
  check("the message value is a valid envelope", envelope !== null);
  check(
    "the envelope carries the full event",
    envelope?.schemaVersion === 1 &&
      envelope.eventId === event.eventId &&
      envelope.organizationId === event.organizationId &&
      envelope.type === event.type &&
      JSON.stringify(envelope.payload) === JSON.stringify(event.payload),
  );
  const receivedAt = Date.parse(envelope?.receivedAt ?? "");
  check("receivedAt is the server time of the request", receivedAt >= before - 1000 && receivedAt <= after + 1000);
  check("occurredAt defaults to receivedAt", envelope?.occurredAt === envelope?.receivedAt);
}

async function checkOccurredAt(): Promise<void> {
  const occurredAt = "2026-01-02T03:04:05.000Z";
  const event = newEvent({ occurredAt });
  const result = await postEvent(event, config.ingestApiToken);
  check("event with occurredAt returns 202", result.status === 202, `got ${result.status} ${result.text}`);
  const envelope = parseEnvelope((await waitForMessages(event.eventId, 1))[0]);
  check("a supplied occurredAt is kept", envelope?.occurredAt === occurredAt && envelope.receivedAt !== occurredAt);
}

async function checkDuplicate(): Promise<void> {
  const event = newEvent();
  const first = await postEvent(event, config.ingestApiToken);
  const second = await postEvent(event, config.ingestApiToken);
  check("the same eventId twice returns 202 both times", first.status === 202 && second.status === 202, `got ${first.status} and ${second.status}`);
  const messages = await waitForMessages(event.eventId, 2);
  check("the duplicate leaves two messages on the topic", messages.length === 2, `found ${messages.length}`);
  check("both copies are on the same partition", messages[0]?.partition === messages[1]?.partition);
  check("the copies have different offsets", messages[0]?.offset !== messages[1]?.offset);
}

async function checkRejections(): Promise<void> {
  const rejected = [newEvent(), newEvent(), newEvent(), newEvent(), newEvent()];
  const [missing, wrong, customerKey, invalid, tooLarge] = rejected;
  mustStayAbsent.push(...rejected.map((event) => event.eventId));

  const noToken = await postEvent(missing);
  check("missing token returns 401 unauthorized", noToken.status === 401 && errorCode(noToken) === "unauthorized", `got ${noToken.status}`);
  const badToken = await postEvent(wrong, "not-the-token");
  check("wrong token returns 401 unauthorized", badToken.status === 401 && errorCode(badToken) === "unauthorized", `got ${badToken.status}`);
  const asCustomer = await postEvent(customerKey, generateApiKey().key);
  check("a customer style api key returns 401 on the event route", asCustomer.status === 401, `got ${asCustomer.status}`);

  const bad = await postEvent({ ...invalid, type: "Not A Type" }, config.ingestApiToken);
  check("invalid body returns 400 validation_error", bad.status === 400 && errorCode(bad) === "validation_error", `got ${bad.status} ${errorCode(bad)}`);

  // the payload alone is over 256 KB, the body limit is checked before any parsing
  const big = await postEvent({ ...tooLarge, payload: { blob: "x".repeat(config.ingestBodyLimitBytes) } }, config.ingestApiToken);
  check("body over 256 KB returns 413 payload_too_large", big.status === 413 && errorCode(big) === "payload_too_large", `got ${big.status} ${errorCode(big)}`);
}

async function checkRouteIsolation(): Promise<void> {
  const res = await fetch(`${config.apiUrl}/v1/webhook-endpoints`, {
    headers: { authorization: `Bearer ${config.ingestApiToken}` },
  });
  check("the ingest token returns 401 on feature 1 routes", res.status === 401, `got ${res.status}`);
}

async function checkNothingLeaked(): Promise<void> {
  await sleep(ABSENCE_GRACE_MS);
  const leaked = mustStayAbsent.filter((eventId) => messagesFor(eventId).length > 0);
  check("rejected requests put nothing on the topic", leaked.length === 0, `${leaked.length} leaked`);
}

async function run(): Promise<void> {
  await warmUp();
  await checkAccepted();
  await checkOccurredAt();
  await checkDuplicate();
  await checkRejections();
  await checkRouteIsolation();
  await checkNothingLeaked();
}

async function main(): Promise<void> {
  let consumer: KafkaJS.Consumer | null = null;
  try {
    consumer = await startConsumer();
    await run();
    console.log("smoke ingest passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`smoke ingest crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exitCode = 1;
  } finally {
    await consumer?.disconnect().catch(() => undefined);
  }
}

await main();
