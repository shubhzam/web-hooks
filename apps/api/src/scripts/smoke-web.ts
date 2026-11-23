import { randomUUID } from "node:crypto";
import { V7Generator, uuidv7 } from "uuidv7";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { createOrganizationWithKey } from "../services/organizations.js";
import { FAR_FUTURE, MOCK_FROM_WORKER, deleteOrganizationRows, newSecret } from "./delivery-kit.js";
import { SmokeFailure, check } from "./smoke-kit.js";

// usage: pnpm --filter api smoke:web
// it needs the whole stack up, web included. it seeds through postgres and then only talks to the
// web app over http, with a cookie header like a browser would send. what it seeds is removed at
// the end. WEB_URL overrides the address of the web app

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3000";
const COOKIE_NAME = "whk_session";
const PAGE_SIZE = 25;
const MINUTE_MS = 60 * 1000;
const FIRST_ENDPOINT_DELIVERIES = 50;
const SECOND_ENDPOINT_DELIVERIES = 10;
const XSS_PAYLOAD = "<script>alert(1)</script>";
const STATUSES = ["pending", "in_progress", "succeeded", "exhausted"] as const;
const EVENT_TYPES = ["invoice.paid", "invoice.failed", "user.created"];

type Status = (typeof STATUSES)[number];

const seededOrganizationIds: string[] = [];
const returnedHtml: string[] = [];

interface Org {
  organizationId: string;
  apiKey: string;
}

interface Seeded {
  id: string;
  endpointId: string;
  status: Status;
  attemptCount: number;
}

interface WebResponse {
  status: number;
  location: string | null;
  html: string;
}

async function seedOrg(label: string): Promise<Org> {
  const { organization, key } = await createOrganizationWithKey(`smoke web ${label} ${Date.now()}`);
  seededOrganizationIds.push(organization.id);
  return { organizationId: organization.id, apiKey: key };
}

async function seedEndpoint(organizationId: string): Promise<string> {
  const id = uuidv7();
  await prisma.webhookEndpoint.create({
    data: {
      id,
      organizationId,
      url: `https://web-smoke.example.com/hooks/${randomUUID()}`,
      description: "smoke web endpoint",
      signingSecret: newSecret(),
      eventTypes: { create: EVENT_TYPES.map((eventType) => ({ eventType })) },
    },
  });
  return id;
}

interface DeliverySpec {
  endpointId: string;
  status: Status;
  index: number;
  createdAtMs: number;
  payload: unknown;
}

// one event and one delivery. pending rows wait far in the future and in progress rows hold a far
// lease, so no worker touches them. the exhausted ones carry three attempts
async function seedDelivery(organizationId: string, spec: DeliverySpec): Promise<Seeded> {
  const id = new V7Generator().generateOrResetWithTs(spec.createdAtMs).toString();
  const eventId = randomUUID();
  const createdAt = new Date(spec.createdAtMs);
  const attempts = attemptsFor(spec.status, spec.index);
  await prisma.event.create({
    data: {
      eventId,
      organizationId,
      type: EVENT_TYPES[spec.index % EVENT_TYPES.length] ?? "invoice.paid",
      payload: spec.payload as object,
      occurredAt: new Date(spec.createdAtMs - 5000),
      receivedAt: new Date(spec.createdAtMs - 3000),
    },
  });
  const attemptCount = spec.status === "in_progress" ? 1 : attempts.length;
  await prisma.delivery.create({
    data: {
      id,
      eventId,
      endpointId: spec.endpointId,
      organizationId,
      status: spec.status,
      attemptCount,
      nextAttemptAt: spec.status === "pending" ? FAR_FUTURE : createdAt,
      leaseExpiresAt: spec.status === "in_progress" ? FAR_FUTURE : null,
      completedAt: spec.status === "succeeded" || spec.status === "exhausted" ? new Date(spec.createdAtMs + MINUTE_MS) : null,
      createdAt,
      cycleStartedAt: createdAt,
    },
  });
  await prisma.deliveryAttempt.createMany({
    data: attempts.map((attempt, position) => ({
      id: uuidv7(),
      deliveryId: id,
      attemptNumber: position + 1,
      startedAt: new Date(spec.createdAtMs + (position + 1) * 1000),
      durationMs: 100 + position,
      responseStatus: attempt.responseStatus,
      error: attempt.error,
    })),
  });
  return { id, endpointId: spec.endpointId, status: spec.status, attemptCount };
}

function attemptsFor(status: Status, index: number): { responseStatus: number | null; error: string | null }[] {
  if (status === "succeeded") return [{ responseStatus: 503, error: "http_503" }, { responseStatus: 200, error: null }];
  if (status === "exhausted") {
    return [
      { responseStatus: 500, error: "http_500" },
      { responseStatus: 503, error: "http_503" },
      { responseStatus: null, error: "timeout" },
    ];
  }
  // a pending delivery either never ran or is waiting for a retry
  if (status === "pending" && Math.floor(index / STATUSES.length) % 2 === 1) return [{ responseStatus: 503, error: "http_503" }];
  return [];
}

async function seedMany(organizationId: string, endpointId: string, count: number, nowMs: number, xssAt: number): Promise<Seeded[]> {
  const seeded: Seeded[] = [];
  for (let index = 0; index < count; index += 1) {
    const payload = index === xssAt ? { note: XSS_PAYLOAD, index } : { index };
    const status = STATUSES[index % STATUSES.length] ?? "pending";
    seeded.push(await seedDelivery(organizationId, { endpointId, status, index, createdAtMs: nowMs - (count - index) * MINUTE_MS, payload }));
  }
  return seeded;
}

function cookieFor(key: string | null): Record<string, string> {
  return key === null ? {} : { cookie: `${COOKIE_NAME}=${key}` };
}

// redirects are not followed, the script has to see them
async function get(path: string, key: string | null): Promise<WebResponse> {
  const res = await fetch(`${WEB_URL}${path}`, { redirect: "manual", headers: cookieFor(key) });
  const html = await res.text();
  returnedHtml.push(html);
  return { status: res.status, location: res.headers.get("location"), html };
}

function redirectsTo(res: WebResponse, pathAndQuery: string): boolean {
  if (res.status < 300 || res.status > 399 || res.location === null) return false;
  const target = new URL(res.location, WEB_URL);
  return `${target.pathname}${target.search}` === pathAndQuery;
}

function statOf(html: string, name: string): number | null {
  const match = html.match(new RegExp(`data-stat="${name}"[^>]*>(\\d+)<`));
  return match?.[1] === undefined ? null : Number(match[1]);
}

function rowStatuses(html: string): string[] {
  return [...html.matchAll(/<tr[^>]*data-status="([a-z_]+)"/g)].map((match) => match[1] ?? "");
}

function deliveryIdsIn(html: string): string[] {
  return [...html.matchAll(/href="\/deliveries\/([0-9a-f-]{36})"/g)].map((match) => match[1] ?? "");
}

// the href of the first link with the given data-link marker
function linkHref(html: string, marker: string): string | null {
  const tag = html.match(new RegExp(`<a[^>]*data-link="${marker}"[^>]*>`))?.[0];
  const href = tag?.match(/href="([^"]*)"/)?.[1];
  return href === undefined ? null : href.replaceAll("&amp;", "&");
}

async function apiStats(org: Org, endpointId: string): Promise<Record<string, number | null>> {
  const res = await fetch(`${config.apiUrl}/v1/webhook-endpoints/${endpointId}/stats`, { headers: { authorization: `Bearer ${org.apiKey}` } });
  return (await res.json()) as Record<string, number | null>;
}

async function checkAccess(org: Org, someDeliveryId: string, endpointId: string): Promise<void> {
  const none = await get("/endpoints", null);
  check("/endpoints without a cookie goes to /login", redirectsTo(none, "/login"), `${none.status} ${none.location}`);
  const garbage = await get("/endpoints", "garbage-key");
  check("/endpoints with a garbage key goes to /login?expired=1", redirectsTo(garbage, "/login?expired=1"), `${garbage.status} ${garbage.location}`);
  const noneDetail = await get(`/endpoints/${endpointId}`, null);
  check("an endpoint page without a cookie goes to /login", redirectsTo(noneDetail, "/login"), `${noneDetail.status} ${noneDetail.location}`);
  const noneDelivery = await get(`/deliveries/${someDeliveryId}`, null);
  check("a delivery page without a cookie goes to /login", redirectsTo(noneDelivery, "/login"), `${noneDelivery.status} ${noneDelivery.location}`);
  const garbageDelivery = await get(`/deliveries/${someDeliveryId}`, "garbage-key");
  check("a delivery page with a garbage key goes to /login?expired=1", redirectsTo(garbageDelivery, "/login?expired=1"), `${garbageDelivery.status} ${garbageDelivery.location}`);
  const login = await get("/login", null);
  check("the login page renders a labelled key field", login.status === 200 && login.html.includes("API key") && login.html.includes('type="password"'));
  const expired = await get("/login?expired=1", null);
  check("the expired notice shows on the login page", expired.status === 200 && expired.html.includes("sign in again"));
  check("a valid cookie is let through", (await get("/endpoints", org.apiKey)).status === 200);
}

async function checkEndpointList(org: Org, urls: string[]): Promise<void> {
  const res = await get("/endpoints", org.apiKey);
  check("/endpoints returns 200", res.status === 200, `${res.status}`);
  check("/endpoints lists both urls", urls.every((url) => res.html.includes(url)));
  check("/endpoints has the create form with labelled inputs", ["URL (https)", "event types, one per line", "description (optional)"].every((label) => res.html.includes(label)));
  check("/endpoints has a table caption", res.html.includes("<caption>"));
}

async function checkEndpointPage(org: Org, endpointId: string, seeded: Seeded[]): Promise<void> {
  const page = await get(`/endpoints/${endpointId}`, org.apiKey);
  check("the endpoint page returns 200", page.status === 200, `${page.status}`);
  const stats = await apiStats(org, endpointId);
  const names = ["total", "succeeded", "exhausted", "pending", "inProgress"];
  const same = names.every((name) => statOf(page.html, name) === stats[name]);
  check("the stats on the page equal the api's", same, `page ${names.map((n) => statOf(page.html, n))} api ${names.map((n) => stats[n])}`);
  check("the success rate is on the page", page.html.includes('data-stat="successRate"'));

  const first = rowStatuses(page.html);
  check(`the first page has ${PAGE_SIZE} rows`, first.length === PAGE_SIZE, `got ${first.length}`);
  const older = linkHref(page.html, "older");
  check("the older link exists with more than 25 rows", older !== null && older.includes("cursor="), String(older));
  check("there is no newest link on the first page", linkHref(page.html, "newest") === null);
  const labels = ["delivered", "failed", "queued", "retrying", "sending"];
  check("the badges carry text labels", labels.every((label) => page.html.includes(`>${label}<`)));

  const second = await get(older ?? "", org.apiKey);
  const secondIds = deliveryIdsIn(second.html);
  const firstIds = deliveryIdsIn(page.html);
  check("the older page shows the other 25 rows", secondIds.length === FIRST_ENDPOINT_DELIVERIES - PAGE_SIZE && secondIds.every((id) => !firstIds.includes(id)));
  check("the older page has a newest link and no older link", linkHref(second.html, "newest") !== null && linkHref(second.html, "older") === null);
  const all = [...firstIds, ...secondIds].sort().reverse();
  const expected = seeded.filter((d) => d.endpointId === endpointId).map((d) => d.id).sort().reverse();
  check("both pages together are every delivery, newest first", JSON.stringify([...firstIds, ...secondIds]) === JSON.stringify(expected) && all.length === expected.length);
  check("the refresh link is there", linkHref(page.html, "refresh") !== null);
}

async function checkFilters(org: Org, endpointId: string, seeded: Seeded[]): Promise<void> {
  for (const status of STATUSES) {
    const res = await get(`/endpoints/${endpointId}?status=${status}`, org.apiKey);
    const rows = rowStatuses(res.html);
    const expected = Math.min(PAGE_SIZE, seeded.filter((d) => d.endpointId === endpointId && d.status === status).length);
    check(`status=${status} shows only ${status} rows, ${expected} of them`, rows.length === expected && rows.every((row) => row === status), `rows ${rows.length}`);
  }
  const typed = await get(`/endpoints/${endpointId}?status=exhausted&eventType=invoice.paid`, org.apiKey);
  check("the status and event type filters combine", rowStatuses(typed.html).every((row) => row === "exhausted") && typed.html.includes("invoice.paid"));
  const junk = await get(`/endpoints/${endpointId}?status=nonsense&cursor=abc`, org.apiKey);
  check("a hand edited url with junk values still renders the list", junk.status === 200 && rowStatuses(junk.html).length === PAGE_SIZE);
  const keepFilters = await get(`/endpoints/${endpointId}?status=pending`, org.apiKey);
  const older = linkHref(keepFilters.html, "older");
  check("a paging link keeps the status filter", older === null || older.includes("status=pending"));
}

async function checkDeliveryPage(org: Org, failed: Seeded, succeeded: Seeded, retrying: Seeded): Promise<void> {
  const page = await get(`/deliveries/${failed.id}`, org.apiKey);
  check("the delivery page returns 200", page.status === 200, `${page.status}`);
  const attempts = [...page.html.matchAll(/data-attempt="(\d+)"/g)].map((match) => match[1]);
  check("the delivery page shows its 3 attempts in order", attempts.join() === "1,2,3", attempts.join());
  check("the attempts show the results", page.html.includes("HTTP 500") && page.html.includes("HTTP 503") && page.html.includes("timeout"));
  check("the payload is escaped", page.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  check("the payload never appears as a raw script tag", !page.html.includes(XSS_PAYLOAD) && !page.html.includes("<script>alert(1)"));
  check("an exhausted delivery has a replay button", page.html.includes('id="replay-heading"') && />replay</.test(page.html));
  check("an exhausted delivery reads failed", page.html.includes(">failed<"));
  check("times are in utc", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/.test(page.html));

  const done = await get(`/deliveries/${succeeded.id}`, org.apiKey);
  check("a delivered delivery has no replay button", done.status === 200 && !done.html.includes('id="replay-heading"') && done.html.includes(">delivered<"));
  const waiting = await get(`/deliveries/${retrying.id}`, org.apiKey);
  check("a pending delivery with attempts reads retrying with its retry time", waiting.html.includes(">retrying<") && /retry at (<!-- -->)?2100-01-01/.test(waiting.html));
  check("a pending delivery has no replay button", !waiting.html.includes('id="replay-heading"'));
}

async function checkIsolation(org: Org, foreignDeliveryId: string, foreignEndpointId: string): Promise<void> {
  const foreign = await get(`/deliveries/${foreignDeliveryId}`, org.apiKey);
  check("another organization's delivery id is a 404", foreign.status === 404, `${foreign.status}`);
  const foreignEndpoint = await get(`/endpoints/${foreignEndpointId}`, org.apiKey);
  check("another organization's endpoint id is a 404", foreignEndpoint.status === 404, `${foreignEndpoint.status}`);
  check("a malformed delivery id is a 404", (await get("/deliveries/not-a-uuid", org.apiKey)).status === 404);
  const unknownId = uuidv7();
  const unknown = await get(`/deliveries/${unknownId}`, org.apiKey);
  check("an unknown delivery id is a 404", unknown.status === 404);
  // the id is echoed back from the url either way, so it is masked before the pages are compared
  const masked = (res: WebResponse, id: string) => res.html.replaceAll(id, "ID");
  check("a foreign id and an unknown id give the same 404 page", masked(foreign, foreignDeliveryId) === masked(unknown, unknownId));
}

async function checkNothingLeaks(org: Org, secrets: string[]): Promise<void> {
  const joined = returnedHtml.join("\n");
  check("the api key never appears in any html", !joined.includes(org.apiKey));
  check("no signing secret appears in any html", !joined.includes("whsec_") && !secrets.some((secret) => joined.includes(secret)));
  check(`${returnedHtml.length} pages were scanned`, returnedHtml.length > 20);
  const home = await get("/", null);
  check("/ still says api: ok", home.status === 200 && home.html.includes("api: ok"), home.html.slice(0, 200));
  check("/ links to /endpoints", home.html.includes('href="/endpoints"'));
}

function pick(seeded: Seeded[], status: Status, attempts: (count: number) => boolean): Seeded {
  const found = seeded.find((d) => d.status === status && attempts(d.attemptCount));
  if (!found) throw new Error(`the seed has no ${status} delivery`);
  return found;
}

async function main(): Promise<void> {
  try {
    const org = await seedOrg("main");
    const other = await seedOrg("other");
    const nowMs = Date.now();
    const endpointA = await seedEndpoint(org.organizationId);
    const endpointB = await seedEndpoint(org.organizationId);
    const foreignEndpoint = await seedEndpoint(other.organizationId);
    const onA = await seedMany(org.organizationId, endpointA, FIRST_ENDPOINT_DELIVERIES, nowMs, 3);
    const onB = await seedMany(org.organizationId, endpointB, SECOND_ENDPOINT_DELIVERIES, nowMs, -1);
    const foreign = await seedMany(other.organizationId, foreignEndpoint, 2, nowMs, -1);
    const seeded = [...onA, ...onB];
    console.log(`seeded ${seeded.length} deliveries on 2 endpoints, one payload holds a script tag`);

    // index 3 holds the script tag, and by the status cycle it is an exhausted delivery
    const xssDelivery = onA[3];
    if (xssDelivery?.status !== "exhausted") throw new Error("the seed is not what the script expects");
    const urls = (await prisma.webhookEndpoint.findMany({ where: { organizationId: org.organizationId }, select: { url: true } })).map((row) => row.url);
    const secrets = (await prisma.webhookEndpoint.findMany({ where: { organizationId: { in: seededOrganizationIds } }, select: { signingSecret: true } })).map((row) => row.signingSecret);

    await checkAccess(org, xssDelivery.id, endpointA);
    await checkEndpointList(org, urls);
    await checkEndpointPage(org, endpointA, seeded);
    await checkFilters(org, endpointA, seeded);
    await checkDeliveryPage(org, xssDelivery, pick(onA, "succeeded", () => true), pick(onA, "pending", (n) => n > 0));
    await checkIsolation(org, foreign[0]?.id ?? "", foreignEndpoint);
    await checkNothingLeaks(org, secrets);
    console.log("smoke web passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`smoke web crashed: ${err instanceof Error ? (err.stack ?? err.message) : "unknown error"}`);
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
