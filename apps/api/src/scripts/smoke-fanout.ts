import { randomUUID } from "node:crypto";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { uuidv7 } from "uuidv7";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { SmokeFailure, check, kafkaClient, postEvent, sleep, startTailConsumer, waitUntil } from "./smoke-kit.js";

// usage: pnpm --filter api smoke:fanout [-- --bulk]
// needs the api, kafka, postgres and a running processor. prints one line per check and exits
// non-zero on the first failure. everything it seeds is removed again at the end

const DB_WAIT_MS = 15000;
const DLQ_WAIT_MS = 15000;
const BULK_WAIT_MS = 60000;
const SETTLE_WAIT_MS = 60000;
const DUPLICATE_WAIT_MS = 3000;
const DLQ_WARMUP_ATTEMPTS = 5;
const DLQ_WARMUP_WAIT_MS = 3000;
const BULK_ENDPOINTS = 200;
const BULK_EVENTS = 100;
const BULK_POST_CONCURRENCY = 10;
const POISON_BYTES = "not json {";

interface EndpointSeed {
  eventTypes: string[];
  status?: "active" | "disabled";
  deletedAt?: Date;
  createdAt?: Date;
}

interface DlqMessage {
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

const seededOrganizationIds: string[] = [];

async function seedOrganization(label: string): Promise<string> {
  const id = uuidv7();
  await prisma.organization.create({ data: { id, name: `smoke fanout ${label} ${Date.now()}` } });
  seededOrganizationIds.push(id);
  return id;
}

async function seedEndpoint(organizationId: string, name: string, seed: EndpointSeed): Promise<string> {
  const id = uuidv7();
  await prisma.webhookEndpoint.create({
    data: {
      id,
      organizationId,
      // a private address, the delivery worker refuses it without any dns or network traffic
      url: `https://10.0.0.5/smoke/${name}/${id}`,
      signingSecret: "whsec_smoke_not_a_real_secret",
      status: seed.status ?? "active",
      ...(seed.deletedAt ? { deletedAt: seed.deletedAt } : {}),
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
      eventTypes: { create: seed.eventTypes.map((eventType) => ({ eventType })) },
    },
  });
  return id;
}

function newEvent(organizationId: string, type: string) {
  return {
    eventId: randomUUID(),
    organizationId,
    type,
    payload: { invoiceId: "inv_smoke", amountCents: 1234 },
  };
}

async function postAccepted(event: ReturnType<typeof newEvent>): Promise<void> {
  const result = await postEvent(event, config.ingestApiToken);
  check(`post ${event.type} returns 202`, result.status === 202, `got ${result.status} ${result.text}`);
}

function eventRowCount(eventId: string): Promise<number> {
  return prisma.event.count({ where: { eventId } });
}

function deliveriesFor(eventId: string) {
  return prisma.delivery.findMany({ where: { eventId }, select: { endpointId: true } });
}

async function waitForEvent(eventId: string): Promise<boolean> {
  return waitUntil(async () => (await eventRowCount(eventId)) > 0, DB_WAIT_MS, 200);
}

async function checkMatching(): Promise<{ organizationId: string; endpoints: Record<string, string> }> {
  const organizationId = await seedOrganization("matching");
  const hourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  const endpoints = {
    A: await seedEndpoint(organizationId, "a", { eventTypes: ["invoice.paid"] }),
    B: await seedEndpoint(organizationId, "b", { eventTypes: ["invoice.paid", "invoice.payment_failed"] }),
    C: await seedEndpoint(organizationId, "c", { eventTypes: ["customer.created"] }),
    D: await seedEndpoint(organizationId, "d", { eventTypes: ["invoice.paid"], status: "disabled" }),
    E: await seedEndpoint(organizationId, "e", { eventTypes: ["invoice.paid"], deletedAt: new Date() }),
    F: await seedEndpoint(organizationId, "f", { eventTypes: ["invoice.paid"], createdAt: hourFromNow }),
  };
  const event = newEvent(organizationId, "invoice.paid");
  await postAccepted(event);

  check("the event row appears within 15s", await waitForEvent(event.eventId));
  check("exactly 1 events row", (await eventRowCount(event.eventId)) === 1);
  const deliveries = await deliveriesFor(event.eventId);
  // any status: the delivery worker may already have picked them up
  check("exactly 2 deliveries", deliveries.length === 2, `found ${deliveries.length}`);
  const targets = deliveries.map((delivery) => delivery.endpointId).sort();
  check("the deliveries are for endpoints A and B", JSON.stringify(targets) === JSON.stringify([endpoints.A, endpoints.B].sort()));
  check("C (other event type) got no delivery", !targets.includes(endpoints.C));
  check("D (disabled) got no delivery", !targets.includes(endpoints.D));
  check("E (soft deleted) got no delivery", !targets.includes(endpoints.E));
  check("F (created after the event) got no delivery", !targets.includes(endpoints.F));
  await checkDuplicate(event);
  return { organizationId, endpoints };
}

async function checkDuplicate(event: ReturnType<typeof newEvent>): Promise<void> {
  await postAccepted(event);
  await sleep(DUPLICATE_WAIT_MS);
  const events = await eventRowCount(event.eventId);
  const deliveries = (await deliveriesFor(event.eventId)).length;
  check("the same eventId again leaves 1 event and 2 deliveries", events === 1 && deliveries === 2, `${events} events, ${deliveries} deliveries`);
}

async function produceRaw(producer: KafkaJS.Producer, key: string, value: string): Promise<void> {
  await producer.send({ topic: config.kafkaTopic, messages: [{ key, value: Buffer.from(value) }] });
}

function toDlqMessage(message: KafkaJS.KafkaMessage): DlqMessage {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    headers[name] = Array.isArray(value) ? value.join(",") : String(value ?? "");
  }
  return { key: message.key?.toString() ?? null, value: message.value?.toString() ?? null, headers };
}

// the tail consumer joins asynchronously, so post canary poison messages until one comes back
async function warmUpDlq(producer: KafkaJS.Producer, dlq: DlqMessage[]): Promise<void> {
  for (let attempt = 1; attempt <= DLQ_WARMUP_ATTEMPTS; attempt++) {
    const canary = `canary-${randomUUID()}`;
    await produceRaw(producer, canary, POISON_BYTES);
    if (await waitUntil(() => dlq.some((m) => m.key === canary), DLQ_WARMUP_WAIT_MS)) {
      check("the dlq consumer sees new messages", true);
      return;
    }
  }
  check("the dlq consumer sees new messages", false, `no canary after ${DLQ_WARMUP_ATTEMPTS} attempts`);
}

async function checkPoison(organizationId: string): Promise<void> {
  const dlq: DlqMessage[] = [];
  const consumer = await startTailConsumer({
    clientId: "smoke-fanout-dlq",
    topic: config.kafkaDlqTopic,
    partitions: 1,
    onMessage: (_partition, message) => dlq.push(toDlqMessage(message)),
  });
  const producer = kafkaClient("smoke-fanout-producer").producer({ "broker.address.family": "v4" });
  await producer.connect();
  try {
    await warmUpDlq(producer, dlq);
    const key = `poison-${randomUUID()}`;
    await produceRaw(producer, key, POISON_BYTES);
    check("the garbage message reaches the dlq within 15s", await waitUntil(() => dlq.some((m) => m.key === key), DLQ_WAIT_MS));
    const copy = dlq.find((m) => m.key === key);
    check("the dlq copy has an error header", (copy?.headers["error"] ?? "") !== "", JSON.stringify(copy?.headers));
    check("the dlq copy keeps the original bytes", copy?.value === POISON_BYTES);
    check(
      "the dlq copy names its source topic, partition and offset",
      copy?.headers["source-topic"] === config.kafkaTopic &&
        /^\d+$/.test(copy.headers["source-partition"] ?? "") &&
        /^\d+$/.test(copy.headers["source-offset"] ?? ""),
    );
    const next = newEvent(organizationId, "invoice.paid");
    await postAccepted(next);
    check("a valid event after the poison is processed", await waitForEvent(next.eventId));
    check("and it produced its 2 deliveries", (await deliveriesFor(next.eventId)).length === 2);
  } finally {
    await producer.disconnect().catch(() => undefined);
    await consumer.disconnect().catch(() => undefined);
  }
}

async function seedBulkOrganization(): Promise<string> {
  const organizationId = await seedOrganization("bulk");
  const ids = Array.from({ length: BULK_ENDPOINTS }, () => uuidv7());
  await prisma.webhookEndpoint.createMany({
    data: ids.map((id) => ({
      id,
      organizationId,
      url: `https://10.0.0.5/smoke/bulk/${id}`,
      signingSecret: "whsec_smoke_not_a_real_secret",
    })),
  });
  await prisma.webhookEndpointEventType.createMany({
    data: ids.map((endpointId) => ({ endpointId, eventType: "bulk.test" })),
  });
  return organizationId;
}

async function postBulkEvents(organizationId: string): Promise<void> {
  const events = Array.from({ length: BULK_EVENTS }, () => newEvent(organizationId, "bulk.test"));
  for (let start = 0; start < events.length; start += BULK_POST_CONCURRENCY) {
    const group = events.slice(start, start + BULK_POST_CONCURRENCY);
    const results = await Promise.all(group.map((event) => postEvent(event, config.ingestApiToken)));
    check(`bulk posts ${start + 1}-${start + group.length} return 202`, results.every((r) => r.status === 202));
  }
}

async function checkBulk(): Promise<void> {
  const organizationId = await seedBulkOrganization();
  const expected = BULK_ENDPOINTS * BULK_EVENTS;
  const startedAt = Date.now();
  await postBulkEvents(organizationId);
  const done = await waitUntil(async () => (await prisma.delivery.count({ where: { organizationId } })) >= expected, BULK_WAIT_MS, 500);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const deliveries = await prisma.delivery.count({ where: { organizationId } });
  check(`${expected} deliveries within 60s (took ${seconds}s)`, done && deliveries === expected, `found ${deliveries}`);
  const events = await prisma.event.count({ where: { organizationId } });
  check(`${BULK_EVENTS} events rows`, events === BULK_EVENTS, `found ${events}`);
}

async function cleanup(): Promise<void> {
  if (seededOrganizationIds.length === 0) return;
  const organizationId = { in: seededOrganizationIds };
  try {
    // the delivery worker consumes these rows, so let it finish before they are deleted
    await waitUntil(
      async () => (await prisma.delivery.count({ where: { organizationId, status: { in: ["pending", "in_progress"] } } })) === 0,
      SETTLE_WAIT_MS,
      500,
    );
    await prisma.deliveryAttempt.deleteMany({ where: { delivery: { organizationId } } });
    await prisma.delivery.deleteMany({ where: { organizationId } });
    await prisma.event.deleteMany({ where: { organizationId } });
    await prisma.webhookEndpointEventType.deleteMany({ where: { endpoint: { organizationId } } });
    await prisma.webhookEndpoint.deleteMany({ where: { organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  } catch (err) {
    console.error(`smoke cleanup failed: ${err instanceof Error ? err.name : "unknown error"}`);
  }
}

async function main(): Promise<void> {
  try {
    if (process.argv.includes("--bulk")) {
      await checkBulk();
    } else {
      const { organizationId } = await checkMatching();
      await checkPoison(organizationId);
    }
    console.log("smoke fanout passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`smoke fanout crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

await main();
