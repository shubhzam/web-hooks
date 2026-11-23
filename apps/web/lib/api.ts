import { notFound, redirect } from "next/navigation";
import {
  deliveryDetailSchema,
  deliveryListResponseSchema,
  endpointStatsSchema,
  replayDeliveryResponseSchema,
  type DeliveryDetail,
  type DeliveryListResponse,
  type DeliveryStatus,
  type EndpointStats,
  type ReplayDeliveryResponse,
} from "@repo/shared/delivery";
import {
  createdWebhookEndpointSchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  type CreateWebhookEndpointInput,
  type CreatedWebhookEndpoint,
  type UpdateWebhookEndpointInput,
  type WebhookEndpoint,
  type WebhookEndpointList,
} from "@repo/shared/webhook-endpoint";
import { config } from "./config";
import { buildQuery } from "./query";
import { requireSession } from "./session";

// the only place the dashboard talks to the api. server code only: it reads the session cookie
// and the key never leaves this process. every response is parsed with the shared schemas

// anything with a parse method, which every zod schema has
interface Parser<T> {
  parse(input: unknown): T;
}

interface ApiProblem {
  code: string;
  message: string;
  details: string[];
}

// the api answered with something other than success. the message here holds the status and the
// error code only, never the key and never the response body. apiMessage and details are the
// short texts the api wrote for a person, so an action can show them
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly apiMessage: string | null;
  readonly details: string[];

  constructor(status: number, problem: ApiProblem | null) {
    super(`api request failed status=${status}${problem ? ` code=${problem.code}` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.code = problem?.code ?? null;
    this.apiMessage = problem?.message ?? null;
    this.details = problem?.details ?? [];
  }
}

// the api could not be reached, or sent something we cannot read
export class ApiUnavailableError extends Error {
  constructor() {
    super("api unavailable");
    this.name = "ApiUnavailableError";
  }
}

interface RawResponse {
  status: number;
  json: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function detailLines(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((item) => {
    if (!isRecord(item) || typeof item["message"] !== "string") return [];
    const path = typeof item["path"] === "string" && item["path"] !== "" ? `${item["path"]}: ` : "";
    return [`${path}${item["message"]}`];
  });
}

// reads the api's { error: { code, message, details? } } shape by hand, null for anything else
function readProblem(json: unknown): ApiProblem | null {
  if (!isRecord(json) || !isRecord(json["error"])) return null;
  const { code, message, details } = json["error"];
  if (typeof code !== "string" || typeof message !== "string") return null;
  return { code, message, details: detailLines(details) };
}

function parseJson(text: string): unknown {
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

// the path goes into the log without its query, filters can hold anything a person typed
function logPath(path: string): string {
  return path.split("?")[0] ?? path;
}

async function send(key: string, method: string, path: string, body: unknown, timeoutMs: number): Promise<RawResponse> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: parseJson(await res.text()) };
  } catch (err) {
    console.error(`api unreachable method=${method} path=${logPath(path)} reason=${err instanceof Error ? err.name : "unknown"}`);
    throw new ApiUnavailableError();
  }
}

interface RequestOptions<T> {
  method?: string;
  path: string;
  body?: unknown;
  // null for a response without a body
  schema: Parser<T> | null;
  timeoutMs?: number;
}

function parseBody<T>(schema: Parser<T>, json: unknown, options: RequestOptions<T>): T {
  try {
    return schema.parse(json);
  } catch {
    console.error(`api response did not match its schema method=${options.method ?? "GET"} path=${logPath(options.path)}`);
    throw new ApiUnavailableError();
  }
}

// a rejected key sends the person to the login page, an unknown id shows the not found page.
// both throw the way next expects, so callers must not swallow them, see unstable_rethrow
async function request<T>(options: RequestOptions<T>): Promise<T> {
  const key = await requireSession();
  const method = options.method ?? "GET";
  const { status, json } = await send(key, method, options.path, options.body, options.timeoutMs ?? config.apiTimeoutMs);
  if (status === 401) redirect("/login?expired=1");
  if (status === 404) notFound();
  if (status < 200 || status >= 300) {
    console.error(`api error method=${method} path=${logPath(options.path)} status=${status}`);
    throw new ApiError(status, readProblem(json));
  }
  return options.schema === null ? (undefined as T) : parseBody(options.schema, json, options);
}

export type KeyCheck = "valid" | "invalid" | "unavailable";

// one cheap authenticated call with the key from the login form, before any cookie exists
export async function checkApiKey(key: string): Promise<KeyCheck> {
  try {
    const { status, json } = await send(key, "GET", "/v1/webhook-endpoints?limit=1", undefined, config.apiTimeoutMs);
    if (status === 401) return "invalid";
    if (status !== 200) return "unavailable";
    webhookEndpointListSchema.parse(json);
    return "valid";
  } catch {
    return "unavailable";
  }
}

function id(value: string): string {
  return encodeURIComponent(value);
}

export function listEndpoints(options: { cursor?: string | undefined }): Promise<WebhookEndpointList> {
  const query = buildQuery({ limit: String(config.endpointsPageSize), cursor: options.cursor });
  return request({ path: `/v1/webhook-endpoints${query}`, schema: webhookEndpointListSchema });
}

export function getEndpoint(endpointId: string): Promise<WebhookEndpoint> {
  return request({ path: `/v1/webhook-endpoints/${id(endpointId)}`, schema: webhookEndpointSchema });
}

export function createEndpoint(input: CreateWebhookEndpointInput): Promise<CreatedWebhookEndpoint> {
  return request({ method: "POST", path: "/v1/webhook-endpoints", body: input, schema: createdWebhookEndpointSchema });
}

export function updateEndpoint(endpointId: string, patch: UpdateWebhookEndpointInput): Promise<WebhookEndpoint> {
  return request({ method: "PATCH", path: `/v1/webhook-endpoints/${id(endpointId)}`, body: patch, schema: webhookEndpointSchema });
}

export function deleteEndpoint(endpointId: string): Promise<void> {
  return request({ method: "DELETE", path: `/v1/webhook-endpoints/${id(endpointId)}`, schema: null });
}

export function getEndpointStats(endpointId: string): Promise<EndpointStats> {
  return request({ path: `/v1/webhook-endpoints/${id(endpointId)}/stats`, schema: endpointStatsSchema, timeoutMs: config.statsTimeoutMs });
}

export interface DeliveryQuery {
  endpointId: string;
  status?: DeliveryStatus | undefined;
  eventType?: string | undefined;
  cursor?: string | undefined;
}

export function listDeliveries(query: DeliveryQuery): Promise<DeliveryListResponse> {
  const search = buildQuery({ ...query, limit: String(config.deliveriesPageSize) });
  return request({ path: `/v1/deliveries${search}`, schema: deliveryListResponseSchema });
}

export function getDelivery(deliveryId: string): Promise<DeliveryDetail> {
  return request({ path: `/v1/deliveries/${id(deliveryId)}`, schema: deliveryDetailSchema });
}

export function replayDelivery(deliveryId: string): Promise<ReplayDeliveryResponse> {
  return request({ method: "POST", path: `/v1/deliveries/${id(deliveryId)}/replay`, schema: replayDeliveryResponseSchema });
}
