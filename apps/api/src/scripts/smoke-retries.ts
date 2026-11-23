import { randomUUID } from "node:crypto";
import * as z from "zod";
import { uuidv7 } from "uuidv7";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { createOrganizationWithKey } from "../services/organizations.js";
import {
  MOCK_FROM_SCRIPT,
  MOCK_FROM_WORKER,
  clearReceived,
  fetchReceived,
  newSecret,
  removeOrganizations,
  seedEvent,
} from "./delivery-kit.js";
import { SmokeFailure, check, sleep, waitUntil } from "./smoke-kit.js";

// usage: pnpm --filter api smoke:retries
// it needs the delivery workers to run with fast settings, start them like this first:
//   DELIVERY_RETRY_DELAYS_MS=500,500,500,500,500,500,500 CIRCUIT_COOLDOWN_MS=8000 \
//   CIRCUIT_RELEASE_SPREAD_MS=2000 docker compose --profile test up -d --force-recreate \
//   --scale delivery-worker=2 delivery-worker
// and then put them back on the defaults afterwards. it also needs the api and the mock receiver.
// it seeds through postgres and replays through the api. prints one line per check and exits
// non-zero on the first failure. everything it seeds is removed again at the end

const WORKER_COMMAND =
  "DELIVERY_RETRY_DELAYS_MS=500,500,500,500,500,500,500 CIRCUIT_COOLDOWN_MS=8000 CIRCUIT_RELEASE_SPREAD_MS=2000 docker compose --profile test up -d --force-recreate --scale delivery-worker=2 delivery-worker";
const FINAL_WAIT_MS = 30000;
const FIRST_SCENARIO_WAIT_MS = 15000;
const MIN_GAP_MS = 350;
const RETRY_AFTER_SECONDS = 3;
const MIN_RETRY_AFTER_GAP_MS = 2800;
const MAX_ATTEMPTS = 8;
const BREAKER_DELIVERIES = 60;
const BREAKER_PAUSE_WAIT_MS = 30000;
const BREAKER_FIRST_LOOK_MS = 2000;
const BREAKER_SECOND_LOOK_MS = 3000;
const BREAKER_HEAL_WAIT_MS = 60000;
const HOURS_AGO_25_MS = 25 * 3600 * 1000;

const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });
const replayBodySchema = z.object({ deliveryId: z.string(), status: z.string() });

const seededOrganizationIds: string[] = [];

interface Seeded {
  deliveryId: string;
  endpointId: string;
}

interface Context {
  organizationId: string;
  apiKey: string;
}

async function seedOrganization(label: string): Promise<Context> {
  const { organization, key } = await createOrganizationWithKey(`smoke retries ${label} ${Date.now()}`);
  seededOrganizationIds.push(organization.id);
  return { organizationId: organization.id, apiKey: key };
}

interface DeliverySeed {
  url: string;
  disabled?: boolean;
  status?: "pending" | "exhausted";
  attemptCount?: number;
  nextAttemptAt?: Date;
  cycleStartedAt?: Date;
}

// one endpoint and one delivery on a fresh event
async function seedDelivery(organizationId: string, seed: DeliverySeed): Promise<Seeded> {
  const { eventId } = await seedEvent(organizationId);
  const endpointId = uuidv7();
  const deliveryId = uuidv7();
  await prisma.webhookEndpoint.create({
    data: {
      id: endpointId,
      organizationId,
      url: seed.url,
      signingSecret: newSecret(),
      status: seed.disabled ? "disabled" : "active",
    },
  });
  await prisma.delivery.create({
    data: {
      id: deliveryId,
      eventId,
      endpointId,
      organizationId,
      ...(seed.status ? { status: seed.status } : {}),
      ...(seed.attemptCount === undefined ? {} : { attemptCount: seed.attemptCount }),
      ...(seed.nextAttemptAt ? { nextAttemptAt: seed.nextAttemptAt } : {}),
      ...(seed.cycleStartedAt ? { cycleStartedAt: seed.cycleStartedAt } : {}),
    },
  });
  return { deliveryId, endpointId };
}

// the same url cannot be registered twice in one organization, so every seeded endpoint gets its own
function uniqueOkUrl(): string {
  return `${MOCK_FROM_WORKER}/ok?m=${randomUUID()}`;
}

function loadDelivery(deliveryId: string) {
  return prisma.delivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { attempts: { orderBy: { attemptNumber: "asc" } } },
  });
}

async function waitForStatus(deliveryId: string, status: "succeeded" | "exhausted", timeoutMs = FINAL_WAIT_MS): Promise<boolean> {
  return waitUntil(async () => (await loadDelivery(deliveryId)).status === status, timeoutMs, 200);
}

// requests the mock saw for one marker. each scenario puts a random marker in its url
async function hitsFor(path: string, marker: string) {
  return (await fetchReceived(path)).filter((hit) => hit.query.includes(marker));
}

function gapsBetween(starts: Date[]): number[] {
  return starts.slice(1).map((start, index) => start.getTime() - (starts[index]?.getTime() ?? 0));
}

function statusesOf(attempts: { responseStatus: number | null }[]): string {
  return attempts.map((attempt) => attempt.responseStatus ?? "none").join(",");
}

async function checkFlaky(context: Context): Promise<void> {
  const id = randomUUID();
  const { deliveryId } = await seedDelivery(context.organizationId, { url: `${MOCK_FROM_WORKER}/flaky?id=${id}&fail=2` });
  const settled = await waitForStatus(deliveryId, "succeeded", FIRST_SCENARIO_WAIT_MS);
  check(
    "flaky: succeeds within 15s, so the worker runs the fast retry settings",
    settled,
    `not done after ${FIRST_SCENARIO_WAIT_MS / 1000}s, the workers are probably on the default delays. start them with: ${WORKER_COMMAND}`,
  );
  const delivery = await loadDelivery(deliveryId);
  check("flaky: 3 attempt rows", delivery.attempts.length === 3, `found ${delivery.attempts.length}`);
  check("flaky: statuses are 500, 500, 200", statusesOf(delivery.attempts) === "500,500,200", statusesOf(delivery.attempts));
  const gaps = gapsBetween(delivery.attempts.map((attempt) => attempt.startedAt));
  check("flaky: attempts are at least 350 ms apart", gaps.every((gap) => gap >= MIN_GAP_MS), `gaps ${gaps.join(",")}`);
  const hits = await hitsFor("/flaky", id);
  check("flaky: the mock saw exactly 3 hits for the id", hits.length === 3, `saw ${hits.length}`);
  check("flaky: every hit carries the delivery id as webhook-id", hits.every((hit) => hit.headers["webhook-id"] === deliveryId));
}

async function checkGone(context: Context): Promise<void> {
  const marker = randomUUID();
  const { deliveryId } = await seedDelivery(context.organizationId, { url: `${MOCK_FROM_WORKER}/gone?m=${marker}` });
  check("gone: exhausted", await waitForStatus(deliveryId, "exhausted"));
  const delivery = await loadDelivery(deliveryId);
  check("gone: exactly 1 attempt", delivery.attempts.length === 1, `found ${delivery.attempts.length}`);
  check("gone: the attempt status is 410", delivery.attempts[0]?.responseStatus === 410);
  check("gone: the mock saw exactly 1 hit", (await hitsFor("/gone", marker)).length === 1);
}

async function checkAlwaysFailing(context: Context, code: number): Promise<void> {
  const marker = randomUUID();
  const { deliveryId } = await seedDelivery(context.organizationId, { url: `${MOCK_FROM_WORKER}/status/${code}?m=${marker}` });
  check(`${code}: exhausted`, await waitForStatus(deliveryId, "exhausted"));
  const delivery = await loadDelivery(deliveryId);
  check(`${code}: exactly ${MAX_ATTEMPTS} attempts`, delivery.attempts.length === MAX_ATTEMPTS, `found ${delivery.attempts.length}`);
  const numbers = delivery.attempts.map((attempt) => attempt.attemptNumber).join(",");
  check(`${code}: the attempts are numbered 1 to ${MAX_ATTEMPTS}`, numbers === "1,2,3,4,5,6,7,8", numbers);
  check(`${code}: every attempt has status ${code}`, delivery.attempts.every((attempt) => attempt.responseStatus === code));
  check(`${code}: the mock saw exactly ${MAX_ATTEMPTS} hits`, (await hitsFor(`/status/${code}`, marker)).length === MAX_ATTEMPTS);
}

async function checkRetryAfter(context: Context): Promise<void> {
  const id = randomUUID();
  const url = `${MOCK_FROM_WORKER}/flaky?id=${id}&fail=1&status=503&retryAfter=${RETRY_AFTER_SECONDS}`;
  const { deliveryId } = await seedDelivery(context.organizationId, { url });
  check("retry-after: succeeded", await waitForStatus(deliveryId, "succeeded"));
  const delivery = await loadDelivery(deliveryId);
  check("retry-after: 2 attempts, 503 then 200", statusesOf(delivery.attempts) === "503,200", statusesOf(delivery.attempts));
  const [gap = 0] = gapsBetween(delivery.attempts.map((attempt) => attempt.startedAt));
  check(`retry-after: the gap is at least ${MIN_RETRY_AFTER_GAP_MS} ms (schedule alone would be 500)`, gap >= MIN_RETRY_AFTER_GAP_MS, `gap ${gap}`);
}

async function checkMaxAge(context: Context): Promise<void> {
  const marker = randomUUID();
  const cycleStartedAt = new Date(Date.now() - HOURS_AGO_25_MS);
  const { deliveryId } = await seedDelivery(context.organizationId, { url: `${MOCK_FROM_WORKER}/ok?m=${marker}`, cycleStartedAt });
  check("max age: exhausted", await waitForStatus(deliveryId, "exhausted"));
  const delivery = await loadDelivery(deliveryId);
  check("max age: 1 attempt row with error max_age_exceeded", delivery.attempts.length === 1 && delivery.attempts[0]?.error === "max_age_exceeded");
  check("max age: the mock saw zero hits", (await hitsFor("/ok", marker)).length === 0);
}

async function seedBreakerDeliveries(organizationId: string): Promise<{ endpointId: string; deliveryIds: string[] }> {
  const endpointId = uuidv7();
  await prisma.webhookEndpoint.create({
    data: { id: endpointId, organizationId, url: `${MOCK_FROM_WORKER}/switch`, signingSecret: newSecret() },
  });
  const events = Array.from({ length: BREAKER_DELIVERIES }, () => randomUUID());
  await prisma.event.createMany({
    data: events.map((eventId) => ({
      eventId,
      organizationId,
      type: "invoice.paid",
      payload: { invoiceId: "inv_breaker_smoke" },
      occurredAt: new Date(),
      receivedAt: new Date(),
    })),
  });
  const deliveryIds = events.map(() => uuidv7());
  await prisma.delivery.createMany({
    data: events.map((eventId, index) => ({ id: deliveryIds[index] ?? uuidv7(), eventId, endpointId, organizationId })),
  });
  return { endpointId, deliveryIds };
}

async function setSwitch(mode: "up" | "down"): Promise<void> {
  const res = await fetch(`${MOCK_FROM_SCRIPT}/control/switch?mode=${mode}`, { method: "POST" });
  check(`the mock switch is ${mode}`, res.status === 204, `got ${res.status}`);
}

async function switchHits(): Promise<number> {
  return (await fetchReceived("/switch")).length;
}

async function pausedUntilOf(endpointId: string): Promise<Date | null> {
  const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId }, select: { pausedUntil: true } });
  return row.pausedUntil;
}

async function checkBreaker(context: Context): Promise<void> {
  await setSwitch("down");
  await clearReceived();
  const { endpointId, deliveryIds } = await seedBreakerDeliveries(context.organizationId);
  try {
    check(
      "breaker: the endpoint gets paused",
      await waitUntil(async () => (await pausedUntilOf(endpointId)) !== null, BREAKER_PAUSE_WAIT_MS, 100),
    );
    await sleep(BREAKER_FIRST_LOOK_MS);
    const first = await switchHits();
    await sleep(BREAKER_SECOND_LOOK_MS);
    const second = await switchHits();
    const pausedUntil = await pausedUntilOf(endpointId);
    check("breaker: the second look is still inside the pause", (pausedUntil?.getTime() ?? 0) > Date.now(), `paused until ${pausedUntil?.toISOString()}`);
    check("breaker: nothing was sent during the pause", first === second, `${first} hits at the first look, ${second} at the second`);
    console.log(`     the mock saw ${second} requests to /switch before and during the pause`);
  } finally {
    await setSwitch("up");
  }
  const organizationId = context.organizationId;
  const healed = await waitUntil(
    async () => (await prisma.delivery.count({ where: { organizationId, endpointId, status: "succeeded" } })) === BREAKER_DELIVERIES,
    BREAKER_HEAL_WAIT_MS,
    500,
  );
  check(`breaker: all ${BREAKER_DELIVERIES} deliveries succeed after the switch goes up`, healed);
  const attempts = await prisma.deliveryAttempt.findMany({
    where: { deliveryId: { in: deliveryIds } },
    select: { deliveryId: true, attemptNumber: true },
    orderBy: { attemptNumber: "asc" },
  });
  const byDelivery = new Map<string, number[]>();
  for (const attempt of attempts) byDelivery.set(attempt.deliveryId, [...(byDelivery.get(attempt.deliveryId) ?? []), attempt.attemptNumber]);
  const contiguous = deliveryIds.every((id) => (byDelivery.get(id) ?? []).every((number, index) => number === index + 1));
  check("breaker: every delivery has attempt numbers 1, 2, 3 and so on with no gap", contiguous);
}

type ApiCall = { status: number; code: string | null; body: unknown };

async function postReplay(token: string, deliveryId: string): Promise<ApiCall> {
  const res = await fetch(`${config.apiUrl}/v1/deliveries/${deliveryId}/replay`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : undefined;
  const error = errorBodySchema.safeParse(body);
  return { status: res.status, code: error.success ? error.data.error.code : null, body };
}

async function checkReplayFlow(context: Context): Promise<string> {
  const id = randomUUID();
  const { deliveryId } = await seedDelivery(context.organizationId, { url: `${MOCK_FROM_WORKER}/flaky?id=${id}&fail=${MAX_ATTEMPTS}` });
  check("replay: exhausted after 8 attempts", await waitForStatus(deliveryId, "exhausted"));
  check("replay: 8 attempt rows", (await loadDelivery(deliveryId)).attempts.length === MAX_ATTEMPTS);

  const replay = await postReplay(context.apiKey, deliveryId);
  const parsed = replayBodySchema.safeParse(replay.body);
  check("replay: the api answers 202", replay.status === 202, `got ${replay.status} ${replay.code}`);
  check("replay: the body is { deliveryId, status: pending }", parsed.success && parsed.data.deliveryId === deliveryId && parsed.data.status === "pending");
  check("replay: succeeded after the replay", await waitForStatus(deliveryId, "succeeded"));
  const delivery = await loadDelivery(deliveryId);
  const numbers = delivery.attempts.map((attempt) => attempt.attemptNumber).join(",");
  check("replay: 9 attempt rows, numbered 1 to 9", delivery.attempts.length === 9 && numbers === "1,2,3,4,5,6,7,8,9", numbers);
  check("replay: attempt 9 has status 200", delivery.attempts[8]?.responseStatus === 200);
  check("replay: replay_base is 8", delivery.replayBase === MAX_ATTEMPTS);

  const again = await postReplay(context.apiKey, deliveryId);
  check("replay: a second replay is 409 delivery_not_replayable", again.status === 409 && again.code === "delivery_not_replayable", `got ${again.status} ${again.code}`);
  return deliveryId;
}

async function checkReplayRefusals(context: Context, other: Context, replayedId: string): Promise<void> {
  const farFuture = new Date(Date.now() + 24 * 3600 * 1000);
  const pending = await seedDelivery(context.organizationId, { url: uniqueOkUrl(), status: "pending", nextAttemptAt: farFuture });
  const pendingReplay = await postReplay(context.apiKey, pending.deliveryId);
  check("replay: a pending delivery is 409 delivery_not_replayable", pendingReplay.status === 409 && pendingReplay.code === "delivery_not_replayable", `got ${pendingReplay.status} ${pendingReplay.code}`);

  const disabled = await seedDelivery(context.organizationId, { url: uniqueOkUrl(), disabled: true, status: "exhausted", attemptCount: 1 });
  const disabledReplay = await postReplay(context.apiKey, disabled.deliveryId);
  check("replay: an exhausted delivery of a disabled endpoint is 409 endpoint_inactive", disabledReplay.status === 409 && disabledReplay.code === "endpoint_inactive", `got ${disabledReplay.status} ${disabledReplay.code}`);
  const stillExhausted = (await loadDelivery(disabled.deliveryId)).status === "exhausted";
  check("replay: the refused delivery is left exhausted", stillExhausted);

  const foreign = await seedDelivery(other.organizationId, { url: uniqueOkUrl(), status: "exhausted", attemptCount: 1 });
  const foreignReplay = await postReplay(context.apiKey, foreign.deliveryId);
  check("replay: another organization's delivery is 404 not_found", foreignReplay.status === 404 && foreignReplay.code === "not_found", `got ${foreignReplay.status} ${foreignReplay.code}`);
  check("replay: and it was not touched", (await loadDelivery(foreign.deliveryId)).status === "exhausted");

  const malformed = await postReplay(context.apiKey, "not-a-uuid");
  check("replay: a malformed id is 404 not_found", malformed.status === 404 && malformed.code === "not_found", `got ${malformed.status}`);
  const unknown = await postReplay(context.apiKey, randomUUID());
  check("replay: an unknown id is 404 not_found", unknown.status === 404 && unknown.code === "not_found", `got ${unknown.status}`);
  const asIngest = await postReplay(config.ingestApiToken, replayedId);
  check("replay: the ingest token is 401", asIngest.status === 401, `got ${asIngest.status}`);
}

async function main(): Promise<void> {
  try {
    const mock = await fetch(`${MOCK_FROM_SCRIPT}/received`).catch(() => null);
    check("the mock receiver is reachable", mock?.ok === true, "start it with docker compose --profile test up -d mock-receiver");
    await clearReceived();
    const context = await seedOrganization("main");
    const other = await seedOrganization("other");
    await checkFlaky(context);
    await checkGone(context);
    await checkAlwaysFailing(context, 404);
    await checkAlwaysFailing(context, 500);
    await checkRetryAfter(context);
    await checkMaxAge(context);
    await checkBreaker(context);
    const replayedId = await checkReplayFlow(context);
    await checkReplayRefusals(context, other, replayedId);
    console.log("smoke retries passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`smoke retries crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exitCode = 1;
  } finally {
    await removeOrganizations(seededOrganizationIds);
    await prisma.$disconnect();
  }
}

await main();
