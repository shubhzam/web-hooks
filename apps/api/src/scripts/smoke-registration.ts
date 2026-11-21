import * as z from "zod";
import {
  createdWebhookEndpointSchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  type CreatedWebhookEndpoint,
} from "@repo/shared/webhook-endpoint";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { createApiKey, generateApiKey, revokeApiKey } from "../services/api-keys.js";
import { createOrganizationWithKey } from "../services/organizations.js";

// usage: pnpm --filter api smoke:registration (needs the api running, see API_URL in config)
// stops at the first failed assertion and exits non-zero

const URL_A = "https://hooks.acme-billing.io/inbound";
const URL_B = "https://hooks.acme-billing.io/second";
const URL_C = "https://hooks.acme-billing.io/third";
const PAID = "invoice.paid";
const FAILED = "invoice.payment_failed";

interface ApiResult {
  status: number;
  text: string;
  json: unknown;
}

interface Tenant {
  organizationId: string;
  key: string;
}

class SmokeFailure extends Error {}

const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const createdOrganizationIds: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) {
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    throw new SmokeFailure(name);
  }
  console.log(`ok   ${name}`);
}

async function call(
  method: string,
  path: string,
  options: { key?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.key) headers["authorization"] = `Bearer ${options.key}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${config.apiUrl}/v1${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  return { status: res.status, text, json };
}

function errorCode(result: ApiResult): string {
  const parsed = errorBodySchema.safeParse(result.json);
  return parsed.success ? parsed.data.error.code : "no error body";
}

function expectError(name: string, result: ApiResult, status: number, code: string): void {
  check(name, result.status === status && errorCode(result) === code, `got ${result.status} ${errorCode(result)}`);
}

async function makeTenant(label: string): Promise<Tenant> {
  const { organization, key } = await createOrganizationWithKey(`smoke ${label} ${Date.now()}`);
  createdOrganizationIds.push(organization.id);
  return { organizationId: organization.id, key };
}

function sameSet(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function liveCount(organizationId: string): Promise<number> {
  return prisma.webhookEndpoint.count({ where: { organizationId, deletedAt: null } });
}

function eventTypeRowCount(organizationId: string): Promise<number> {
  return prisma.webhookEndpointEventType.count({ where: { endpoint: { organizationId } } });
}

async function createEndpoint(tenant: Tenant, url: string, eventTypes: string[]) {
  return call("POST", "/webhook-endpoints", { key: tenant.key, body: { url, eventTypes } });
}

async function createOrFail(tenant: Tenant, url: string, eventTypes: string[]): Promise<CreatedWebhookEndpoint> {
  const result = await createEndpoint(tenant, url, eventTypes);
  check(`setup: create ${url} returns 201`, result.status === 201, `got ${result.status} ${result.text}`);
  return createdWebhookEndpointSchema.parse(result.json);
}

async function checkAuth(acme: Tenant): Promise<void> {
  const revoked = await createApiKey(acme.organizationId);
  await revokeApiKey(revoked.id);
  const attempts = {
    "missing header": undefined,
    "malformed key": "nope",
    "unknown key": generateApiKey().key,
    "revoked key": revoked.key,
  };
  const before = await liveCount(acme.organizationId);
  const bodies = new Set<string>();
  for (const [label, key] of Object.entries(attempts)) {
    const result = await call("POST", "/webhook-endpoints", {
      ...(key === undefined ? {} : { key }),
      body: { url: URL_A, eventTypes: [PAID] },
    });
    expectError(`[done-when] ${label} returns 401 unauthorized`, result, 401, "unauthorized");
    bodies.add(result.text);
  }
  check("[trace revoked-or-unknown key] all four 401 bodies are identical", bodies.size === 1);
  const after = await liveCount(acme.organizationId);
  check("[trace revoked-or-unknown key] unauthorized requests wrote nothing", after === before, `${before} -> ${after}`);
}

async function checkCreate(acme: Tenant): Promise<CreatedWebhookEndpoint> {
  const result = await createEndpoint(acme, URL_A, [PAID, FAILED]);
  check("[done-when] create returns 201", result.status === 201, `got ${result.status} ${result.text}`);
  const created = createdWebhookEndpointSchema.parse(result.json);
  check("[done-when] create response includes a whsec_ secret", /^whsec_[A-Za-z0-9+/]{43}=$/.test(created.signingSecret));
  check("create response echoes url, event types and active status", created.url === URL_A && created.status === "active" && sameSet(created.eventTypes, [PAID, FAILED]));

  const row = await prisma.webhookEndpoint.findUnique({ where: { id: created.id }, include: { eventTypes: true } });
  check("[done-when] postgres row matches the response", row?.url === created.url && row.signingSecret === created.signingSecret && row.organizationId === acme.organizationId && row.deletedAt === null);
  check("[done-when] postgres event type rows match the response", sameSet(row?.eventTypes.map((e) => e.eventType) ?? [], created.eventTypes));
  check("[trace success] success writes 1 endpoint row and 2 event type rows", (await liveCount(acme.organizationId)) === 1 && (await eventTypeRowCount(acme.organizationId)) === 2);
  return created;
}

async function checkNoSecretLeaks(acme: Tenant, created: CreatedWebhookEndpoint): Promise<void> {
  const list = await call("GET", "/webhook-endpoints", { key: acme.key });
  const parsedList = webhookEndpointListSchema.parse(list.json);
  check("[done-when] list returns the endpoint", parsedList.data.some((e) => e.id === created.id));
  check("[done-when] list never contains a secret", !list.text.includes("signingSecret") && !list.text.includes(created.signingSecret) && !list.text.includes("whsec_"));
  const one = await call("GET", `/webhook-endpoints/${created.id}`, { key: acme.key });
  webhookEndpointSchema.parse(one.json);
  check("get by id returns 200 without a secret", one.status === 200 && !one.text.includes("signingSecret") && !one.text.includes("whsec_"));
}

async function checkDuplicateUrl(acme: Tenant, created: CreatedWebhookEndpoint): Promise<void> {
  const endpointsBefore = await liveCount(acme.organizationId);
  const eventTypesBefore = await eventTypeRowCount(acme.organizationId);
  const retry = await createEndpoint(acme, URL_A, ["customer.created"]);
  expectError("[done-when] same url twice returns 409 endpoint_url_exists", retry, 409, "endpoint_url_exists");
  const endpointsAfter = await liveCount(acme.organizationId);
  const eventTypesAfter = await eventTypeRowCount(acme.organizationId);
  check("[trace duplicate url] the duplicate rolled back, 0 rows written", endpointsAfter === endpointsBefore && eventTypesAfter === eventTypesBefore, `endpoints ${endpointsBefore}->${endpointsAfter}, event types ${eventTypesBefore}->${eventTypesAfter}`);
  const lookup = await call("GET", `/webhook-endpoints/${created.id}`, { key: acme.key });
  check("[trace lost response] after a lost response the secret cannot be fetched again", !retry.text.includes(created.signingSecret) && !lookup.text.includes(created.signingSecret));
}

async function checkCrossOrg(acme: Tenant, created: CreatedWebhookEndpoint): Promise<void> {
  const other = await makeTenant("other");
  const path = `/webhook-endpoints/${created.id}`;
  expectError("[done-when] another org's id returns 404 on get", await call("GET", path, { key: other.key }), 404, "not_found");
  expectError("another org's id returns 404 on patch", await call("PATCH", path, { key: other.key, body: { status: "disabled" } }), 404, "not_found");
  expectError("another org's id returns 404 on delete", await call("DELETE", path, { key: other.key }), 404, "not_found");
  const untouched = await call("GET", path, { key: acme.key });
  check("the owner's endpoint is untouched after cross-org attempts", untouched.status === 200 && webhookEndpointSchema.parse(untouched.json).status === "active");
  const sameUrl = await createEndpoint(other, URL_A, [PAID]);
  check("the same url is allowed in a different org", sameUrl.status === 201, `got ${sameUrl.status}`);
  const otherList = webhookEndpointListSchema.parse((await call("GET", "/webhook-endpoints", { key: other.key })).json);
  check("another org's list does not show this org's endpoints", otherList.data.every((e) => e.id !== created.id));
}

async function checkPatch(acme: Tenant, created: CreatedWebhookEndpoint): Promise<CreatedWebhookEndpoint> {
  const second = await createOrFail(acme, URL_B, [PAID]);
  const path = `/webhook-endpoints/${created.id}`;
  const patched = await call("PATCH", path, { key: acme.key, body: { eventTypes: ["customer.created"], description: "billing hooks", status: "disabled" } });
  const body = webhookEndpointSchema.parse(patched.json);
  check("patch returns 200 and replaces the whole event type set", patched.status === 200 && sameSet(body.eventTypes, ["customer.created"]) && body.status === "disabled" && body.description === "billing hooks");
  check("patch response has no secret", !patched.text.includes("signingSecret"));
  check("patch moves updatedAt forward", Date.parse(body.updatedAt) > Date.parse(created.updatedAt));
  const rows = await prisma.webhookEndpointEventType.findMany({ where: { endpointId: created.id } });
  check("postgres holds exactly the replaced event type rows", sameSet(rows.map((r) => r.eventType), ["customer.created"]));
  const cleared = await call("PATCH", path, { key: acme.key, body: { description: null } });
  check("patch with description null clears it", webhookEndpointSchema.parse(cleared.json).description === null);
  expectError("patch with no fields returns 400", await call("PATCH", path, { key: acme.key, body: {} }), 400, "validation_error");
  const collide = await call("PATCH", path, { key: acme.key, body: { url: URL_B } });
  expectError("patch to a url already in use returns 409", collide, 409, "endpoint_url_exists");
  const still = await call("GET", path, { key: acme.key });
  check("a failed patch changed nothing", webhookEndpointSchema.parse(still.json).url === URL_A);
  return second;
}

async function checkValidation(acme: Tenant): Promise<void> {
  const cases: Array<[string, unknown]> = [
    ["http url", { url: "http://example.com/x", eventTypes: [PAID] }],
    ["localhost url", { url: "https://localhost/x", eventTypes: [PAID] }],
    ["private ipv4 url", { url: "https://10.0.0.5/x", eventTypes: [PAID] }],
    ["loopback ipv6 url", { url: "https://[::1]/x", eventTypes: [PAID] }],
    ["url with credentials", { url: "https://user:pw@example.com/x", eventTypes: [PAID] }],
    ["bad event type", { url: URL_C, eventTypes: ["Invoice"] }],
    ["no event types", { url: URL_C, eventTypes: [] }],
    ["21 event types", { url: URL_C, eventTypes: Array.from({ length: 21 }, (_, i) => `a.b${i}`) }],
    ["description over 200 chars", { url: URL_C, eventTypes: [PAID], description: "x".repeat(201) }],
    ["unknown field", { url: URL_C, eventTypes: [PAID], signingSecret: "whsec_mine" }],
  ];
  for (const [label, body] of cases) {
    const result = await call("POST", "/webhook-endpoints", { key: acme.key, body });
    expectError(`validation: ${label} returns 400`, result, 400, "validation_error");
  }
  const before = await liveCount(acme.organizationId);
  check("validation failures wrote nothing", before === 2, `expected 2 live endpoints, found ${before}`);
}

async function checkPagination(acme: Tenant): Promise<void> {
  await createOrFail(acme, URL_C, [PAID]);
  const first = webhookEndpointListSchema.parse((await call("GET", "/webhook-endpoints?limit=2", { key: acme.key })).json);
  check("list with limit 2 returns 2 items and a cursor", first.data.length === 2 && first.nextCursor === first.data[1]?.id);
  const next = webhookEndpointListSchema.parse((await call("GET", `/webhook-endpoints?limit=2&cursor=${first.nextCursor}`, { key: acme.key })).json);
  check("the cursor returns the rest and then stops", next.data.length === 1 && next.nextCursor === null);
  const ids = [...first.data, ...next.data].map((e) => e.id);
  check("pages come back in creation order", JSON.stringify(ids) === JSON.stringify([...ids].sort()));
  expectError("limit above 100 returns 400", await call("GET", "/webhook-endpoints?limit=101", { key: acme.key }), 400, "validation_error");
}

async function checkDeleteAndRecreate(acme: Tenant, created: CreatedWebhookEndpoint): Promise<void> {
  const path = `/webhook-endpoints/${created.id}`;
  const removed = await call("DELETE", path, { key: acme.key });
  check("delete returns 204 with no body", removed.status === 204 && removed.text === "");
  expectError("a deleted endpoint returns 404", await call("GET", path, { key: acme.key }), 404, "not_found");
  expectError("deleting twice returns 404", await call("DELETE", path, { key: acme.key }), 404, "not_found");
  const list = webhookEndpointListSchema.parse((await call("GET", "/webhook-endpoints", { key: acme.key })).json);
  check("a deleted endpoint is not listed", list.data.every((e) => e.id !== created.id));
  const row = await prisma.webhookEndpoint.findUnique({ where: { id: created.id } });
  check("delete is soft, the row stays with deleted_at set", row !== null && row.deletedAt !== null);

  const again = await createEndpoint(acme, URL_A, [PAID]);
  check("[done-when] a deleted url can be registered again", again.status === 201, `got ${again.status} ${again.text}`);
  const recreated = createdWebhookEndpointSchema.parse(again.json);
  check("the re-created endpoint is a new row with a new secret", recreated.id !== created.id && recreated.signingSecret !== created.signingSecret);
}

async function cleanup(): Promise<void> {
  const where = { organizationId: { in: createdOrganizationIds } };
  try {
    // event type rows go with their endpoint through the cascade
    await prisma.webhookEndpoint.deleteMany({ where });
    await prisma.apiKey.deleteMany({ where });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
  } catch (err) {
    console.error(`smoke cleanup failed: ${err instanceof Error ? err.name : "unknown error"}`);
  }
}

async function run(): Promise<void> {
  const acme = await makeTenant("acme");
  await checkAuth(acme);
  const created = await checkCreate(acme);
  await checkNoSecretLeaks(acme, created);
  await checkDuplicateUrl(acme, created);
  await checkCrossOrg(acme, created);
  await checkPatch(acme, created);
  await checkValidation(acme);
  await checkPagination(acme);
  await checkDeleteAndRecreate(acme, created);
}

run()
  .then(() => console.log("smoke registration passed"))
  .catch((err: unknown) => {
    if (!(err instanceof SmokeFailure)) {
      console.error(`smoke registration crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
