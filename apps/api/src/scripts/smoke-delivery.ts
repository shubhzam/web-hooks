import { createHmac } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { prisma } from "../lib/prisma.js";
import { MOCK_FROM_SCRIPT, MOCK_FROM_WORKER, clearReceived, fetchReceived, newSecret, removeOrganizations, seedEvent } from "./delivery-kit.js";
import { SmokeFailure, check, waitUntil } from "./smoke-kit.js";

// usage: pnpm --filter api smoke:delivery [-- --load]
// needs postgres, a running delivery worker and the mock receiver (compose --profile test).
// it seeds deliveries straight into postgres, so no kafka is involved. prints one line per check
// and exits non-zero on the first failure. everything it seeds is removed again at the end.
// failed deliveries are retried, so the failing targets are only checked on their first attempt

const DELIVERY_WAIT_MS = 30000;
const LOAD_WAIT_MS = 60000;
const LOAD_DELIVERIES = 500;
const SIGNATURE_WINDOW_SECONDS = 60;
const SLOW_MIN_MS = 9000;
const SLOW_MAX_MS = 13000;

interface Target {
  name: string;
  url: string;
  disabled?: boolean;
}

interface Seeded {
  organizationId: string;
  eventId: string;
  payload: { invoiceId: string; amountCents: number };
  byName: Map<string, { deliveryId: string; endpointId: string; secret: string }>;
}

const seededOrganizationIds: string[] = [];

const TARGETS: Target[] = [
  { name: "ok", url: `${MOCK_FROM_WORKER}/ok` },
  { name: "fail", url: `${MOCK_FROM_WORKER}/fail` },
  { name: "slow", url: `${MOCK_FROM_WORKER}/slow` },
  { name: "redirect", url: `${MOCK_FROM_WORKER}/redirect` },
  { name: "inactive", url: `${MOCK_FROM_WORKER}/inactive`, disabled: true },
  { name: "metadata", url: "https://169.254.169.254/latest" },
  { name: "localhost", url: "https://localhost:9/x" },
  { name: "private", url: "https://10.0.0.5/x" },
];

async function seedOrganization(label: string): Promise<string> {
  const id = uuidv7();
  await prisma.organization.create({ data: { id, name: `smoke delivery ${label} ${Date.now()}` } });
  seededOrganizationIds.push(id);
  return id;
}

async function seedTargets(): Promise<Seeded> {
  const organizationId = await seedOrganization("targets");
  const { eventId, payload } = await seedEvent(organizationId);
  const byName: Seeded["byName"] = new Map();
  for (const target of TARGETS) {
    const endpointId = uuidv7();
    const deliveryId = uuidv7();
    const secret = newSecret();
    await prisma.webhookEndpoint.create({
      data: {
        id: endpointId,
        organizationId,
        url: target.url,
        signingSecret: secret,
        status: target.disabled ? "disabled" : "active",
      },
    });
    await prisma.delivery.create({ data: { id: deliveryId, eventId, endpointId, organizationId } });
    byName.set(target.name, { deliveryId, endpointId, secret });
  }
  return { organizationId, eventId, payload, byName };
}

// every delivery has its first attempt written. the failing ones go on retrying afterwards, so
// this is the most that can be asked of them
async function waitForFirstAttempts(organizationId: string, total: number, timeoutMs: number): Promise<boolean> {
  return waitUntil(async () => (await prisma.deliveryAttempt.count({ where: { delivery: { organizationId }, attemptNumber: 1 } })) === total, timeoutMs, 250);
}

async function waitForAll(organizationId: string, total: number, timeoutMs: number): Promise<boolean> {
  return waitUntil(
    async () => {
      const done = await prisma.delivery.count({ where: { organizationId, status: { in: ["succeeded", "exhausted"] } } });
      return done === total;
    },
    timeoutMs,
    250,
  );
}

async function loadDelivery(seeded: Seeded, name: string) {
  const ids = seeded.byName.get(name);
  if (!ids) throw new Error(`no seeded target ${name}`);
  const delivery = await prisma.delivery.findUniqueOrThrow({
    where: { id: ids.deliveryId },
    include: { attempts: { orderBy: { attemptNumber: "asc" } } },
  });
  return { ...ids, delivery, attempt: delivery.attempts[0] };
}

// recomputed here with node:crypto on purpose, it must not share code with the service
function expectedSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

async function checkOk(seeded: Seeded): Promise<void> {
  const { deliveryId, secret, delivery, attempt } = await loadDelivery(seeded, "ok");
  check("/ok: the delivery is succeeded", delivery.status === "succeeded", `got ${delivery.status}`);
  check("/ok: attempt_count is 1", delivery.attemptCount === 1);
  check("/ok: one attempt row with response_status 200", delivery.attempts.length === 1 && attempt?.responseStatus === 200 && attempt.error === null);

  const hits = await fetchReceived("/ok");
  check("/ok: the mock logged exactly one request", hits.length === 1, `logged ${hits.length}`);
  const hit = hits[0];
  const id = hit?.headers["webhook-id"] ?? "";
  const timestamp = hit?.headers["webhook-timestamp"] ?? "";
  check("/ok: webhook-id equals the delivery id", id === deliveryId);
  check("/ok: webhook-timestamp is within 60s of now", Math.abs(Date.now() / 1000 - Number(timestamp)) <= SIGNATURE_WINDOW_SECONDS);
  check("/ok: the signature verifies independently", hit?.headers["webhook-signature"] === expectedSignature(secret, id, timestamp, hit?.body ?? ""));
  const body = JSON.parse(hit?.body ?? "{}") as Record<string, unknown>;
  check(
    "/ok: the body has eventId, type, occurredAt and data",
    body["eventId"] === seeded.eventId &&
      body["type"] === "invoice.paid" &&
      typeof body["occurredAt"] === "string" &&
      JSON.stringify(body["data"]) === JSON.stringify(seeded.payload),
  );
}

async function checkExhausted(seeded: Seeded, name: string, error: string, status: number | null): Promise<void> {
  const { delivery, attempt } = await loadDelivery(seeded, name);
  check(`${name}: the delivery is exhausted`, delivery.status === "exhausted", `got ${delivery.status}`);
  check(`${name}: error is ${error}`, attempt?.error === error, `got ${attempt?.error}`);
  check(`${name}: response_status is ${status}`, (attempt?.responseStatus ?? null) === status, `got ${attempt?.responseStatus}`);
}

async function checkFirstAttempt(seeded: Seeded, name: string, error: string, status: number | null): Promise<void> {
  const { attempt } = await loadDelivery(seeded, name);
  check(`${name}: the first attempt row has error ${error}`, attempt?.attemptNumber === 1 && attempt.error === error, `got ${attempt?.error}`);
  check(`${name}: the first attempt response_status is ${status}`, (attempt?.responseStatus ?? null) === status, `got ${attempt?.responseStatus}`);
}

async function checkSlow(seeded: Seeded): Promise<void> {
  await checkFirstAttempt(seeded, "slow", "timeout", null);
  const { attempt } = await loadDelivery(seeded, "slow");
  const tookMs = attempt?.durationMs ?? 0;
  check("/slow: the first attempt gave up between 9s and 13s", tookMs >= SLOW_MIN_MS && tookMs <= SLOW_MAX_MS, `took ${tookMs}ms`);
}

async function checkRedirect(seeded: Seeded): Promise<void> {
  await checkFirstAttempt(seeded, "redirect", "http_302", 302);
  check("/redirect: the mock logged zero hits on /target", (await fetchReceived("/target")).length === 0);
}

async function checkBlocked(seeded: Seeded): Promise<void> {
  for (const name of ["metadata", "localhost", "private"]) {
    await checkExhausted(seeded, name, "blocked_address", null);
  }
}

async function checkInactive(seeded: Seeded): Promise<void> {
  await checkExhausted(seeded, "inactive", "endpoint_inactive", null);
  check("/inactive: the mock logged zero hits on /inactive", (await fetchReceived("/inactive")).length === 0);
}

async function checkTargets(): Promise<void> {
  await clearReceived();
  const seeded = await seedTargets();
  check(
    "every delivery has a first attempt within 30s",
    await waitForFirstAttempts(seeded.organizationId, TARGETS.length, DELIVERY_WAIT_MS),
  );
  await checkOk(seeded);
  await checkFirstAttempt(seeded, "fail", "http_500", 500);
  await checkSlow(seeded);
  await checkRedirect(seeded);
  await checkBlocked(seeded);
  await checkInactive(seeded);
}

// 500 endpoints on one event, so every delivery has its own url and its own ?d= tag
async function seedLoad(): Promise<string> {
  const organizationId = await seedOrganization("load");
  const { eventId } = await seedEvent(organizationId);
  const endpointIds = Array.from({ length: LOAD_DELIVERIES }, () => uuidv7());
  await prisma.webhookEndpoint.createMany({
    data: endpointIds.map((id, n) => ({
      id,
      organizationId,
      url: `${MOCK_FROM_WORKER}/ok?d=${n}`,
      signingSecret: newSecret(),
    })),
  });
  await prisma.delivery.createMany({
    data: endpointIds.map((endpointId) => ({ id: uuidv7(), eventId, endpointId, organizationId })),
  });
  return organizationId;
}

async function checkLoad(): Promise<void> {
  await clearReceived();
  const organizationId = await seedLoad();
  const startedAt = Date.now();
  const done = await waitForAll(organizationId, LOAD_DELIVERIES, LOAD_WAIT_MS);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const succeeded = await prisma.delivery.count({ where: { organizationId, status: "succeeded" } });
  check(`all ${LOAD_DELIVERIES} deliveries succeed within 60s (took ${seconds}s)`, done && succeeded === LOAD_DELIVERIES, `${succeeded} succeeded`);
  const attempts = await prisma.deliveryAttempt.count({ where: { delivery: { organizationId } } });
  check(`${LOAD_DELIVERIES} attempt rows exist`, attempts === LOAD_DELIVERIES, `found ${attempts}`);
  const hits = await fetchReceived("/ok");
  check(`the mock logged ${LOAD_DELIVERIES} requests`, hits.length === LOAD_DELIVERIES, `logged ${hits.length}`);
  const distinctIds = new Set(hits.map((hit) => hit.headers["webhook-id"]));
  check(`${LOAD_DELIVERIES} distinct webhook-id values, no duplicate sends`, distinctIds.size === LOAD_DELIVERIES, `${distinctIds.size} distinct`);
  const distinctTags = new Set(hits.map((hit) => hit.query));
  check(`every ?d= tag arrived exactly once`, distinctTags.size === LOAD_DELIVERIES, `${distinctTags.size} distinct`);
}

async function main(): Promise<void> {
  try {
    const mock = await fetch(`${MOCK_FROM_SCRIPT}/received`).catch(() => null);
    check("the mock receiver is reachable", mock?.ok === true, `start it with docker compose --profile test up -d mock-receiver`);
    if (process.argv.includes("--load")) await checkLoad();
    else await checkTargets();
    console.log("smoke delivery passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`smoke delivery crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exitCode = 1;
  } finally {
    await removeOrganizations(seededOrganizationIds);
    await prisma.$disconnect();
  }
}

await main();
