import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { V7Generator, uuidv7 } from "uuidv7";
import {
  deliveryDetailSchema,
  deliveryListResponseSchema,
  endpointStatsSchema,
  type DeliveryListItem,
  type DeliveryStatus,
} from "@repo/shared/delivery";
import { config } from "../config.js";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { createOrganizationWithKey } from "../services/organizations.js";
import { listQuery, statsQuery } from "../services/delivery/queries.js";
import { FAR_FUTURE, MOCK_FROM_WORKER, deleteOrganizationRows, newSecret } from "./delivery-kit.js";
import { SmokeFailure, check } from "./smoke-kit.js";

// usage: pnpm --filter api smoke:dashboard-api
// it needs the stack up (postgres and the api). if a stale dev server holds localhost:3001, start
// it with API_URL=http://127.0.0.1:3001. it seeds through postgres, reads through the api with
// real keys, and removes everything it seeded at the end, including the 100k rows of the plan check

const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const SEEDED_DELIVERIES = 120;
const OLD_DELIVERIES = 10;
const OLD_BASE_MS = 25 * HOUR_MS;
const OLD_STEP_MS = 30 * MINUTE_MS;
const RECENT_STEP_MS = 12 * MINUTE_MS;
const PAGE_LIMIT = 50;
const FILTER_PAGE_LIMIT = 7;
const MAX_PAGES = 100;
const PAUSE_AHEAD_MS = 10 * MINUTE_MS;
const PAUSE_BEHIND_MS = HOUR_MS;
const PLAN_ROWS = 100000;
// rows of other tenants mixed in by time, without them the planner is right to use the primary key
const NOISE_ROWS = 300000;
const NOISE_ENDPOINTS = 20;
const PLAN_SPREAD_SECONDS = 7 * 24 * 3600;
const PLAN_DEEP_OFFSET = PLAN_ROWS / 2;

const STATUSES: DeliveryStatus[] = ["pending", "in_progress", "succeeded", "exhausted"];
const EVENT_TYPES = ["invoice.paid", "invoice.failed", "user.created"];
const NIL_UUID = "00000000-0000-7000-8000-000000000000";

const seededOrganizationIds: string[] = [];
const seenResponseTexts: string[] = [];
const seededSecrets: string[] = [];

interface Org {
  organizationId: string;
  apiKey: string;
}

interface SeededAttempt {
  attemptNumber: number;
  responseStatus: number | null;
  error: string | null;
}

interface SeededDelivery {
  id: string;
  eventId: string;
  endpointId: string;
  eventType: string;
  status: DeliveryStatus;
  attemptCount: number;
  createdAt: Date;
  attempts: SeededAttempt[];
  payload: { marker: string; index: number; nested: { ok: boolean } };
}

interface ApiResult {
  status: number;
  text: string;
  json: unknown;
}

async function seedOrg(label: string): Promise<Org> {
  const { organization, key } = await createOrganizationWithKey(`smoke dashboard ${label} ${Date.now()}`);
  seededOrganizationIds.push(organization.id);
  return { organizationId: organization.id, apiKey: key };
}

async function seedEndpoint(
  organizationId: string,
  extra: { pausedUntil?: Date; deletedAt?: Date } = {},
): Promise<string> {
  const id = uuidv7();
  const signingSecret = newSecret();
  seededSecrets.push(signingSecret);
  await prisma.webhookEndpoint.create({
    data: { id, organizationId, url: `${MOCK_FROM_WORKER}/ok?m=${randomUUID()}`, signingSecret, ...extra },
  });
  return id;
}

// ten deliveries older than the stats window, then 110 inside it, oldest first
function planTimestamps(nowMs: number): number[] {
  const recentCount = SEEDED_DELIVERIES - OLD_DELIVERIES;
  const old = Array.from({ length: OLD_DELIVERIES }, (_, k) => nowMs - OLD_BASE_MS - k * OLD_STEP_MS);
  const recent = Array.from({ length: recentCount }, (_, k) => nowMs - (recentCount - k) * RECENT_STEP_MS);
  return [...old, ...recent].sort((a, b) => a - b);
}

function attemptsFor(status: DeliveryStatus, index: number): SeededAttempt[] {
  if (status === "succeeded") {
    return [
      { attemptNumber: 1, responseStatus: 503, error: "http_503" },
      { attemptNumber: 2, responseStatus: 200, error: null },
    ];
  }
  if (status === "exhausted") {
    return [
      { attemptNumber: 1, responseStatus: 500, error: "http_500" },
      { attemptNumber: 2, responseStatus: 503, error: "http_503" },
      { attemptNumber: 3, responseStatus: null, error: "timeout" },
    ];
  }
  // a pending delivery either never ran or is waiting for a retry
  if (status === "pending" && index % 2 === 1) return [{ attemptNumber: 1, responseStatus: 503, error: "http_503" }];
  return [];
}

// endpoint, event type and status vary independently enough that every combination exists
function planDeliveries(endpointIds: [string, string], nowMs: number): SeededDelivery[] {
  return planTimestamps(nowMs).map((ms, index) => {
    const status = STATUSES[Math.floor(index / 3) % STATUSES.length] ?? "pending";
    const attempts = attemptsFor(status, index);
    return {
      id: new V7Generator().generateOrResetWithTs(ms).toString(),
      eventId: randomUUID(),
      endpointId: endpointIds[index % 2] ?? endpointIds[0],
      eventType: EVENT_TYPES[index % 3] ?? "invoice.paid",
      status,
      attemptCount: status === "in_progress" ? 1 : attempts.length,
      createdAt: new Date(ms),
      attempts,
      payload: { marker: "dashboard-smoke", index, nested: { ok: true } },
    };
  });
}

async function insertPlan(organizationId: string, plan: SeededDelivery[]): Promise<void> {
  await prisma.event.createMany({
    data: plan.map((d) => ({
      eventId: d.eventId,
      organizationId,
      type: d.eventType,
      payload: d.payload,
      occurredAt: new Date(d.createdAt.getTime() - 5000),
      receivedAt: new Date(d.createdAt.getTime() - 3000),
    })),
  });
  // pending rows wait far in the future and in progress rows hold a far lease, so no worker touches them
  await prisma.delivery.createMany({
    data: plan.map((d) => ({
      id: d.id,
      eventId: d.eventId,
      endpointId: d.endpointId,
      organizationId,
      status: d.status,
      attemptCount: d.attemptCount,
      nextAttemptAt: d.status === "pending" ? FAR_FUTURE : d.createdAt,
      leaseExpiresAt: d.status === "in_progress" ? FAR_FUTURE : null,
      completedAt: d.status === "succeeded" || d.status === "exhausted" ? new Date(d.createdAt.getTime() + MINUTE_MS) : null,
      createdAt: d.createdAt,
      cycleStartedAt: d.createdAt,
    })),
  });
  // inserted newest attempt first, so the order in the response has to come from the query
  await prisma.deliveryAttempt.createMany({
    data: plan.flatMap((d) =>
      [...d.attempts].reverse().map((a) => ({
        id: uuidv7(),
        deliveryId: d.id,
        attemptNumber: a.attemptNumber,
        startedAt: new Date(d.createdAt.getTime() + a.attemptNumber * 1000),
        durationMs: 100 + a.attemptNumber,
        responseStatus: a.responseStatus,
        error: a.error,
      })),
    ),
  });
}

async function call(path: string, apiKey: string | null, method = "GET"): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (apiKey !== null) headers["authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${config.apiUrl}${path}`, { method, headers });
  const text = await res.text();
  seenResponseTexts.push(text);
  return { status: res.status, text, json: text ? (JSON.parse(text) as unknown) : undefined };
}

function errorCodeOf(result: ApiResult): string | null {
  const body = result.json;
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = body.error;
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function queryString(params: Record<string, string>): string {
  const text = new URLSearchParams(params).toString();
  return text ? `?${text}` : "";
}

interface Collected {
  items: DeliveryListItem[];
  requests: number;
  lastNextCursor: string | null;
}

// follows nextCursor to the end of the list
async function collect(org: Org, params: Record<string, string>, limit: number): Promise<Collected> {
  const items: DeliveryListItem[] = [];
  let cursor: string | null = null;
  let requests = 0;
  do {
    const query: Record<string, string> = { ...params, limit: String(limit), ...(cursor ? { cursor } : {}) };
    const res = await call(`/v1/deliveries${queryString(query)}`, org.apiKey);
    // only a failure prints, a passing page would be one line per request
    if (res.status !== 200) check(`list request ${requests + 1} returns 200`, false, `${res.status} ${res.text.slice(0, 200)}`);
    const page = deliveryListResponseSchema.parse(res.json);
    items.push(...page.items);
    cursor = page.nextCursor;
    requests += 1;
  } while (cursor !== null && requests < MAX_PAGES);
  return { items, requests, lastNextCursor: cursor };
}

function strictlyDescending(ids: string[]): boolean {
  return ids.every((id, index) => index === 0 || id < (ids[index - 1] ?? ""));
}

function expectedIds(plan: SeededDelivery[], matches: (d: SeededDelivery) => boolean): string[] {
  return plan.filter(matches).map((d) => d.id).sort().reverse();
}

async function checkPaging(org: Org, plan: SeededDelivery[]): Promise<void> {
  const collected = await collect(org, {}, PAGE_LIMIT);
  const ids = collected.items.map((item) => item.id);
  check("paging with limit=50 takes exactly 3 requests", collected.requests === 3, `took ${collected.requests}`);
  check("the pages hold 120 items in total", ids.length === SEEDED_DELIVERIES, `got ${ids.length}`);
  check("the 120 ids are distinct", new Set(ids).size === SEEDED_DELIVERIES);
  check("the ids are strictly descending across pages", strictlyDescending(ids));
  check("the last page has no nextCursor", collected.lastNextCursor === null);
  check("the ids are exactly the seeded ids, newest first", JSON.stringify(ids) === JSON.stringify(expectedIds(plan, () => true)));

  const first = deliveryListResponseSchema.parse((await call(`/v1/deliveries?limit=${PAGE_LIMIT}`, org.apiKey)).json);
  check("the first page has 50 items and a nextCursor equal to its last id", first.items.length === PAGE_LIMIT && first.nextCursor === first.items.at(-1)?.id);
  const defaultPage = deliveryListResponseSchema.parse((await call("/v1/deliveries", org.apiKey)).json);
  check("the default page size is 50", defaultPage.items.length === PAGE_LIMIT);
}

async function checkFilter(org: Org, plan: SeededDelivery[], name: string, params: Record<string, string>, matches: (d: SeededDelivery) => boolean): Promise<void> {
  const collected = await collect(org, params, FILTER_PAGE_LIMIT);
  const ids = collected.items.map((item) => item.id);
  const expected = expectedIds(plan, matches);
  check(`${name}: ${expected.length} rows, newest first, nothing else`, JSON.stringify(ids) === JSON.stringify(expected), `got ${ids.length}`);
  const byId = new Map(plan.map((d) => [d.id, d]));
  const consistent = collected.items.every((item) => {
    const seeded = byId.get(item.id);
    return seeded !== undefined && seeded.status === item.status && seeded.endpointId === item.endpointId && seeded.eventType === item.eventType;
  });
  check(`${name}: every row carries its seeded status, endpoint and event type`, consistent);
}

async function checkFilters(org: Org, plan: SeededDelivery[], endpoints: [string, string]): Promise<void> {
  const [first, second] = endpoints;
  await checkFilter(org, plan, "endpointId", { endpointId: first }, (d) => d.endpointId === first);
  for (const status of STATUSES) {
    await checkFilter(org, plan, `status=${status}`, { status }, (d) => d.status === status);
  }
  for (const eventType of EVENT_TYPES) {
    await checkFilter(org, plan, `eventType=${eventType}`, { eventType }, (d) => d.eventType === eventType);
  }
  await checkFilter(
    org,
    plan,
    "endpointId and status and eventType",
    { endpointId: second, status: "exhausted", eventType: "invoice.paid" },
    (d) => d.endpointId === second && d.status === "exhausted" && d.eventType === "invoice.paid",
  );
  await checkFilter(org, plan, "endpointId and status", { endpointId: first, status: "pending" }, (d) => d.endpointId === first && d.status === "pending");
  await checkFilter(org, plan, "status and eventType", { status: "succeeded", eventType: "user.created" }, (d) => d.status === "succeeded" && d.eventType === "user.created");
  await checkFilter(org, plan, "an unknown eventType matches nothing", { eventType: "no.such_type" }, () => false);
}

async function checkItemShape(org: Org, plan: SeededDelivery[]): Promise<void> {
  const res = await call(`/v1/deliveries?limit=${PAGE_LIMIT}`, org.apiKey);
  check("list items carry no event payload", !res.text.includes("dashboard-smoke") && !res.text.includes('"payload"'));
  const page = deliveryListResponseSchema.parse(res.json);
  const byId = new Map(plan.map((d) => [d.id, d]));
  const lastAttemptsRight = page.items.every((item) => {
    const seeded = byId.get(item.id);
    const last = seeded?.attempts.at(-1);
    if (!seeded || !last) return item.lastAttempt === null;
    return item.lastAttempt?.responseStatus === last.responseStatus && item.lastAttempt?.error === last.error;
  });
  check("lastAttempt is the attempt with the highest number, or null", lastAttemptsRight);
  const attemptCountsRight = page.items.every((item) => byId.get(item.id)?.attemptCount === item.attemptCount);
  check("attemptCount matches the seeded rows", attemptCountsRight);
}

async function checkDetail(org: Org, other: Org, plan: SeededDelivery[]): Promise<void> {
  const target = plan.find((d) => d.status === "exhausted" && d.attempts.length === 3);
  if (!target) throw new Error("the seed has no exhausted delivery");
  const res = await call(`/v1/deliveries/${target.id}`, org.apiKey);
  check("detail returns 200", res.status === 200, `${res.status} ${res.text.slice(0, 200)}`);
  const detail = deliveryDetailSchema.parse(res.json);
  check("detail attempts come in attempt number order", detail.attempts.map((a) => a.attemptNumber).join() === "1,2,3");
  check("detail attempts carry the seeded statuses and errors", detail.attempts.map((a) => `${a.responseStatus}/${a.error}`).join() === "500/http_500,503/http_503,null/timeout");
  // postgres jsonb does not keep key order, so the payload is compared by structure
  check("detail event has the seeded id, type and payload", detail.event.id === target.eventId && detail.event.type === target.eventType && isDeepStrictEqual(detail.event.payload, target.payload));
  check("detail event has occurredAt and receivedAt", detail.event.occurredAt === new Date(target.createdAt.getTime() - 5000).toISOString() && detail.event.receivedAt === new Date(target.createdAt.getTime() - 3000).toISOString());
  check("detail repeats the list fields", detail.status === "exhausted" && detail.endpointId === target.endpointId && detail.eventType === target.eventType && detail.lastAttempt?.error === "timeout");

  const pending = plan.find((d) => d.status === "pending" && d.attempts.length === 0);
  const noAttempts = pending ? deliveryDetailSchema.parse((await call(`/v1/deliveries/${pending.id}`, org.apiKey)).json) : null;
  check("a delivery that never ran has an empty attempts list and no lastAttempt", noAttempts !== null && noAttempts.attempts.length === 0 && noAttempts.lastAttempt === null);

  const foreign = await call(`/v1/deliveries/${target.id}`, other.apiKey);
  check("another organization gets 404 not_found on detail", foreign.status === 404 && errorCodeOf(foreign) === "not_found", `${foreign.status}`);
  check("a malformed id gets 404 on detail", (await call("/v1/deliveries/not-a-uuid", org.apiKey)).status === 404);
  check("an unknown id gets 404 on detail", (await call(`/v1/deliveries/${uuidv7()}`, org.apiKey)).status === 404);
}

async function checkReplayRoute(org: Org, plan: SeededDelivery[]): Promise<void> {
  const succeeded = plan.find((d) => d.status === "succeeded");
  if (!succeeded) throw new Error("the seed has no succeeded delivery");
  const res = await call(`/v1/deliveries/${succeeded.id}/replay`, org.apiKey, "POST");
  check("replay is still routed: a succeeded delivery gets 409 delivery_not_replayable", res.status === 409 && errorCodeOf(res) === "delivery_not_replayable", `${res.status} ${res.text}`);
}

async function checkErrors(org: Org): Promise<void> {
  const cases: [string, string, number][] = [
    ["a bad cursor", "/v1/deliveries?cursor=abc", 400],
    ["a limit of 0", "/v1/deliveries?limit=0", 400],
    ["a limit of 101", "/v1/deliveries?limit=101", 400],
    ["a status that does not exist", "/v1/deliveries?status=failed", 400],
    ["a bad endpointId", "/v1/deliveries?endpointId=nope", 400],
  ];
  for (const [name, path, expected] of cases) {
    const res = await call(path, org.apiKey);
    check(`${name} is a ${expected} validation_error`, res.status === expected && errorCodeOf(res) === "validation_error", `${res.status} ${res.text}`);
    const details = (res.json as { error?: { details?: unknown } }).error?.details;
    check(`${name} lists the problem in details`, Array.isArray(details) && details.length > 0);
  }
  for (const path of ["/v1/deliveries", `/v1/deliveries/${NIL_UUID}`, `/v1/webhook-endpoints/${NIL_UUID}/stats`]) {
    check(`${path} without a key is 401`, (await call(path, null)).status === 401);
    check(`${path} with the ingest token is 401`, (await call(path, config.ingestApiToken)).status === 401);
  }
}

interface DirectCounts {
  pending: number;
  inProgress: number;
  succeeded: number;
  exhausted: number;
}

// the counts straight from the table, filtered on created_at where the api filters on the id bound
async function directCounts(endpointId: string, since: Date): Promise<DirectCounts> {
  const groups = await prisma.delivery.groupBy({
    by: ["status"],
    where: { endpointId, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const countOf = (status: DeliveryStatus) => groups.find((g) => g.status === status)?._count._all ?? 0;
  return { pending: countOf("pending"), inProgress: countOf("in_progress"), succeeded: countOf("succeeded"), exhausted: countOf("exhausted") };
}

async function fetchStats(org: Org, endpointId: string) {
  const res = await call(`/v1/webhook-endpoints/${endpointId}/stats`, org.apiKey);
  check("stats returns 200", res.status === 200, `${res.status} ${res.text.slice(0, 200)}`);
  return endpointStatsSchema.parse(res.json);
}

async function checkStatsFor(org: Org, endpointId: string, name: string): Promise<void> {
  const since = new Date(Date.now() - config.deliveryStatsWindowMs);
  const stats = await fetchStats(org, endpointId);
  const direct = await directCounts(endpointId, since);
  const sameCounts =
    stats.pending === direct.pending && stats.inProgress === direct.inProgress && stats.succeeded === direct.succeeded && stats.exhausted === direct.exhausted;
  check(`${name}: counts equal a direct count query`, sameCounts, `${JSON.stringify(stats)} vs ${JSON.stringify(direct)}`);
  const finished = direct.succeeded + direct.exhausted;
  const expectedRate = finished === 0 ? null : direct.succeeded / finished;
  check(`${name}: total and successRate follow the definition`, stats.total === direct.pending + direct.inProgress + finished && stats.successRate === expectedRate, JSON.stringify(stats));
  const allTime = await prisma.delivery.count({ where: { endpointId } });
  check(`${name}: deliveries older than 24h are excluded`, stats.total < allTime, `${stats.total} of ${allTime}`);
}

async function checkStats(org: Org, endpoints: [string, string], plan: SeededDelivery[]): Promise<void> {
  const [first, second] = endpoints;
  await checkStatsFor(org, first, "endpoint one");
  await checkStatsFor(org, second, "endpoint two");
  const old = plan.filter((d) => d.createdAt.getTime() < Date.now() - config.deliveryStatsWindowMs);
  const firstStats = await fetchStats(org, first);
  const recentOnFirst = plan.filter((d) => d.endpointId === first && !old.includes(d)).length;
  check("endpoint one counts only the 24h deliveries it was seeded with", firstStats.total === recentOnFirst, `${firstStats.total} vs ${recentOnFirst}`);
  check("the window label is 24h", firstStats.window === "24h");
  check("a pause that has passed is reported as null", firstStats.pausedUntil === null);

  const secondStats = await fetchStats(org, second);
  const pausedUntil = secondStats.pausedUntil === null ? 0 : Date.parse(secondStats.pausedUntil);
  check("a pause in the future is reported", pausedUntil > Date.now() && pausedUntil <= Date.now() + PAUSE_AHEAD_MS);
}

async function checkStatsEdges(org: Org, other: Org, endpoints: { first: string; empty: string; deleted: string }): Promise<void> {
  const empty = await fetchStats(org, endpoints.empty);
  check("an endpoint with no deliveries has zero counts and a null successRate", empty.total === 0 && empty.successRate === null && empty.pending === 0 && empty.succeeded === 0, JSON.stringify(empty));
  const foreign = await call(`/v1/webhook-endpoints/${endpoints.first}/stats`, other.apiKey);
  check("another organization gets 404 not_found on stats", foreign.status === 404 && errorCodeOf(foreign) === "not_found", `${foreign.status}`);
  check("a malformed id gets 404 on stats", (await call("/v1/webhook-endpoints/not-a-uuid/stats", org.apiKey)).status === 404);
  check("an unknown id gets 404 on stats", (await call(`/v1/webhook-endpoints/${uuidv7()}/stats`, org.apiKey)).status === 404);
  check("a deleted endpoint gets 404 on stats", (await call(`/v1/webhook-endpoints/${endpoints.deleted}/stats`, org.apiKey)).status === 404);
  // not recorded: feature 1 returns the url here on purpose, the leak scan covers only the dashboard routes
  const plain = await fetch(`${config.apiUrl}/v1/webhook-endpoints/${endpoints.first}`, { headers: { authorization: `Bearer ${org.apiKey}` } });
  check("the endpoint route itself is unchanged", plain.status === 200);
}

async function checkOtherOrgSeesNothing(org: Org, other: Org, endpointId: string): Promise<void> {
  const all = deliveryListResponseSchema.parse((await call("/v1/deliveries", other.apiKey)).json);
  check("another organization lists no deliveries", all.items.length === 0 && all.nextCursor === null);
  const probe = deliveryListResponseSchema.parse((await call(`/v1/deliveries?endpointId=${endpointId}`, other.apiKey)).json);
  check("another organization filtering on a foreign endpoint gets an empty list", probe.items.length === 0);
  const own = await call("/v1/deliveries?limit=1", org.apiKey);
  check("the owning organization still sees its deliveries", deliveryListResponseSchema.parse(own.json).items.length === 1);
}

function checkNoSecretsLeaked(): void {
  const joined = seenResponseTexts.join("\n");
  check("no response contains a signing secret", !seededSecrets.some((secret) => joined.includes(secret)) && !joined.includes("whsec_"));
  check("no response mentions a signing secret field", !/signing/i.test(joined));
  check("no response contains an endpoint url", !joined.includes("mock-receiver"));
}

// a deterministic event id for row g that is a valid uuid, so the events insert and the deliveries
// insert agree on it. md5 alone gives no version or variant bits and the response schema would reject it
function eventIdSql(tag: string, g: string): Prisma.Sql {
  const hash = Prisma.sql`md5(${tag} || ${Prisma.raw(g)}::text)`;
  return Prisma.sql`(substr(${hash}, 1, 12) || '4' || substr(${hash}, 14, 3) || '8' || substr(${hash}, 18, 3) || substr(${hash}, 21))::uuid`;
}

// seeds rows with sql, much faster than client side inserts. the rows go round robin over the
// organization's endpoints and are spread over a week, so tenants interleave by id
async function seedBulk(organizationId: string, rows: number): Promise<void> {
  const tag = randomUUID();
  const times = Prisma.sql`LATERAL (SELECT now() - (g::double precision / ${rows}::int) * ${PLAN_SPREAD_SECONDS}::double precision * interval '1 second' AS t) AS times`;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO events (event_id, organization_id, type, payload, occurred_at, received_at)
    SELECT ${eventIdSql(tag, "g")}, ${organizationId}::uuid,
           (ARRAY['invoice.paid', 'invoice.failed', 'user.created'])[1 + g % 3], '{"seed":"plan"}'::jsonb, t, t
    FROM generate_series(1, ${rows}::int) AS g, ${times}`);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO deliveries (id, event_id, endpoint_id, organization_id, status, attempt_count,
                            next_attempt_at, lease_expires_at, completed_at, created_at, cycle_started_at)
    SELECT (substr(s.h, 1, 8) || '-' || substr(s.h, 9, 4) || '-7' || substr(s.r, 1, 3) || '-8' || substr(s.r, 4, 3) || '-' || substr(s.r, 7, 12))::uuid,
           ${eventIdSql(tag, "s.g")}, s.endpoint_id, ${organizationId}::uuid,
           s.status::delivery_status,
           CASE s.status WHEN 'succeeded' THEN 1 WHEN 'exhausted' THEN 1 WHEN 'in_progress' THEN 1 ELSE 0 END,
           CASE WHEN s.status = 'pending' THEN ${FAR_FUTURE}::timestamptz ELSE s.t END,
           CASE WHEN s.status = 'in_progress' THEN ${FAR_FUTURE}::timestamptz END,
           CASE WHEN s.status IN ('succeeded', 'exhausted') THEN s.t + interval '1 minute' END,
           s.t, s.t
    FROM (
      SELECT g, t,
             ep.ids[1 + g % cardinality(ep.ids)] AS endpoint_id,
             lpad(to_hex((extract(epoch FROM t) * 1000)::bigint), 12, '0') AS h,
             md5(random()::text || g::text) AS r,
             CASE WHEN g % 10 < 6 THEN 'succeeded' WHEN g % 10 < 8 THEN 'exhausted'
                  WHEN g % 10 = 8 THEN 'pending' ELSE 'in_progress' END AS status
      FROM generate_series(1, ${rows}::int) AS g, ${times},
           (SELECT array_agg(id ORDER BY id) AS ids FROM webhook_endpoints WHERE organization_id = ${organizationId}::uuid) AS ep
    ) s`);
  // one attempt for every finished delivery, so the last attempt lookup has a real table to search
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO delivery_attempts (id, delivery_id, attempt_number, started_at, duration_ms, response_status, error)
    SELECT gen_random_uuid(), id, 1, created_at, 120, CASE WHEN status = 'succeeded' THEN 200 ELSE 503 END,
           CASE WHEN status = 'succeeded' THEN NULL ELSE 'http_503' END
    FROM deliveries
    WHERE organization_id = ${organizationId}::uuid AND status IN ('succeeded', 'exhausted')`);
}

async function explain(query: Prisma.Sql): Promise<{ lines: string[]; executionMs: number }> {
  const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE, BUFFERS) ${query.text}`, ...query.values);
  const lines = rows.map((row) => row["QUERY PLAN"]);
  const timing = lines.join("\n").match(/Execution Time: ([\d.]+) ms/);
  return { lines, executionMs: Number(timing?.[1] ?? Number.NaN) };
}

// the first run warms the cache, the second is the one reported
async function warmExplain(query: Prisma.Sql): Promise<{ lines: string[]; executionMs: number }> {
  await explain(query);
  return explain(query);
}

function printPlan(title: string, plan: { lines: string[]; executionMs: number }): void {
  console.log(`\nEXPLAIN (ANALYZE, BUFFERS) ${title}`);
  for (const line of plan.lines) console.log(`    ${line}`);
  console.log(`  execution time: ${plan.executionMs} ms\n`);
}

const NEW_INDEX = /deliveries_(endpoint_id_id|organization_id_id)_idx/;

function checkPlan(name: string, plan: { lines: string[]; executionMs: number }, indexName: RegExp): void {
  const text = plan.lines.join("\n");
  check(`${name}: uses one of the new indexes`, indexName.test(text), text);
  check(`${name}: no sequential scan on deliveries`, !/Seq Scan on deliveries/.test(text), text);
}

async function timedCall(path: string, apiKey: string): Promise<{ ms: number; result: ApiResult }> {
  const startedAt = performance.now();
  const result = await call(path, apiKey);
  return { ms: Math.round(performance.now() - startedAt), result };
}

async function checkPlans(): Promise<void> {
  const org = await seedOrg("plan");
  const endpointId = await seedEndpoint(org.organizationId);
  const noiseOrg = await seedOrg("plan noise");
  for (let i = 0; i < NOISE_ENDPOINTS; i += 1) await seedEndpoint(noiseOrg.organizationId);
  console.log(`seeding ${PLAN_ROWS} deliveries for one endpoint and ${NOISE_ROWS} for ${NOISE_ENDPOINTS} endpoints of another organization`);
  await seedBulk(org.organizationId, PLAN_ROWS);
  await seedBulk(noiseOrg.organizationId, NOISE_ROWS);
  // fresh statistics, the planner has seen none of these rows yet
  for (const table of ["deliveries", "events", "delivery_attempts"]) await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
  const count = await prisma.delivery.count({ where: { endpointId } });
  const total = await prisma.delivery.count();
  check(`${PLAN_ROWS} deliveries seeded for the endpoint`, count === PLAN_ROWS, `found ${count}`);
  console.log(`the deliveries table holds ${total} rows, ${Math.round((count / total) * 100)}% of them for the endpoint`);

  const [deep] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM deliveries WHERE endpoint_id = ${endpointId}::uuid ORDER BY id DESC OFFSET ${PLAN_DEEP_OFFSET} LIMIT 1`;
  const cursor = deep?.id;
  if (!cursor) throw new Error("no cursor row");

  const byOrganization = listQuery(org.organizationId, { limit: PAGE_LIMIT, cursor });
  const byEndpoint = listQuery(org.organizationId, { limit: PAGE_LIMIT, cursor, endpointId });
  const orgPlan = await warmExplain(byOrganization);
  const endpointPlan = await warmExplain(byEndpoint);
  const statsPlan = await warmExplain(statsQuery(org.organizationId, endpointId, new Date(Date.now() - config.deliveryStatsWindowMs)));
  printPlan(`list, organization scope, page in the middle of ${PLAN_ROWS} rows`, orgPlan);
  printPlan(`list, endpointId filter, page in the middle of ${PLAN_ROWS} rows`, endpointPlan);
  printPlan(`stats, last 24h of ${PLAN_ROWS} rows`, statsPlan);

  checkPlan("list by organization", orgPlan, /Index Scan Backward using deliveries_organization_id_id_idx/);
  checkPlan("list by endpoint", endpointPlan, /Index Scan Backward using deliveries_(endpoint_id_id|organization_id_id)_idx/);
  check("both list plans read deliveries in index order, no sort on id", !/Sort Key: d\.id/.test(orgPlan.lines.join("\n") + endpointPlan.lines.join("\n")));
  checkPlan("stats", statsPlan, NEW_INDEX);
  console.log(`list (organization scope) execution: ${orgPlan.executionMs} ms`);
  console.log(`list (endpoint filter) execution: ${endpointPlan.executionMs} ms`);
  console.log(`stats execution: ${statsPlan.executionMs} ms`);

  await checkBulkOverHttp(org, endpointId, cursor);
}

async function checkBulkOverHttp(org: Org, endpointId: string, cursor: string): Promise<void> {
  const list = await timedCall(`/v1/deliveries?endpointId=${endpointId}&limit=${PAGE_LIMIT}&cursor=${cursor}`, org.apiKey);
  const page = deliveryListResponseSchema.parse(list.result.json);
  check(`over http: the middle page returns 50 items in ${list.ms} ms`, page.items.length === PAGE_LIMIT && page.nextCursor !== null);
  const since = new Date(Date.now() - config.deliveryStatsWindowMs);
  const statsCall = await timedCall(`/v1/webhook-endpoints/${endpointId}/stats`, org.apiKey);
  const stats = endpointStatsSchema.parse(statsCall.result.json);
  const direct = await directCounts(endpointId, since);
  const same = stats.pending === direct.pending && stats.inProgress === direct.inProgress && stats.succeeded === direct.succeeded && stats.exhausted === direct.exhausted;
  check(`over http: stats of ${stats.total} deliveries equal a direct count, in ${statsCall.ms} ms`, same, `${JSON.stringify(stats)} vs ${JSON.stringify(direct)}`);
}

async function checkSmallSeed(): Promise<void> {
  const org = await seedOrg("main");
  const other = await seedOrg("other");
  const nowMs = Date.now();
  const first = await seedEndpoint(org.organizationId, { pausedUntil: new Date(nowMs - PAUSE_BEHIND_MS) });
  const second = await seedEndpoint(org.organizationId, { pausedUntil: new Date(nowMs + PAUSE_AHEAD_MS) });
  const empty = await seedEndpoint(org.organizationId);
  const deleted = await seedEndpoint(org.organizationId, { deletedAt: new Date() });
  const plan = planDeliveries([first, second], nowMs);
  await insertPlan(org.organizationId, plan);
  console.log(`seeded ${plan.length} deliveries on 2 endpoints, ${OLD_DELIVERIES} of them older than 24h`);

  await checkPaging(org, plan);
  await checkFilters(org, plan, [first, second]);
  await checkItemShape(org, plan);
  await checkDetail(org, other, plan);
  await checkReplayRoute(org, plan);
  await checkErrors(org);
  await checkStats(org, [first, second], plan);
  await checkStatsEdges(org, other, { first, empty, deleted });
  await checkOtherOrgSeesNothing(org, other, first);
  checkNoSecretsLeaked();
}

async function main(): Promise<void> {
  try {
    await checkSmallSeed();
    await checkPlans();
    console.log("smoke dashboard api passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`smoke dashboard api crashed: ${err instanceof Error ? (err.stack ?? err.message) : "unknown error"}`);
    }
    process.exitCode = 1;
  } finally {
    try {
      await deleteOrganizationRows(seededOrganizationIds);
      console.log("cleaned up the seeded rows");
    } catch (err) {
      console.error(`smoke cleanup failed: ${err instanceof Error ? err.name : "unknown error"}`);
    }
    await prisma.$disconnect();
  }
}

void main();
