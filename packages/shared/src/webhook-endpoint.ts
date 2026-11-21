import * as z from "zod";

// this file is reused by the web app, so keep it pure js: no node imports

const MAX_URL_LENGTH = 2048;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_EVENT_TYPES = 20;
// not in the techspec, but the event type column is btree indexed, so it needs a ceiling
const MAX_EVENT_TYPE_LENGTH = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;

function isBlockedIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// expands a compressed ipv6 literal into 8 groups, null when it is not valid hex
function parseIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const head = parseGroups(halves[0] ?? "");
  const tail = parseGroups(halves[1] ?? "");
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : groups;
}

// the url parser rewrites ipv4-mapped addresses to hex, so ::ffff:7f00:1 is how 127.0.0.1 shows up
function embeddedIpv4(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (!leadingZero || (g5 !== 0 && g5 !== 0xffff)) return null;
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

function isBlockedIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  // a literal we cannot read is not a literal we can vouch for
  if (!groups) return true;
  const [g0 = 0] = groups;
  const isUnspecifiedOrLoopback = groups.slice(0, 7).every((g) => g === 0) && (groups[7] ?? 0) <= 1;
  const isUniqueLocal = (g0 & 0xfe00) === 0xfc00;
  const isLinkLocal = (g0 & 0xffc0) === 0xfe80;
  const mapped = embeddedIpv4(groups);
  return isUnspecifiedOrLoopback || isUniqueLocal || isLinkLocal || (mapped !== null && isBlockedIpv4(mapped));
}

function isBlockedHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.startsWith("[") && hostname.endsWith("]")) return isBlockedIpv6(hostname.slice(1, -1));
  return IPV4_PATTERN.test(hostname) && isBlockedIpv4(hostname);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// returns the first reason the url is not acceptable, or undefined when it is fine
export function webhookUrlProblem(value: string): string | undefined {
  // keeps the stored value identical to what we validated, and keeps it inside the btree row limit
  if (!PRINTABLE_ASCII_PATTERN.test(value)) return "url must be ascii, use punycode and percent-encoding";
  const url = parseUrl(value);
  if (!url) return "url is not valid";
  if (url.protocol !== "https:") return "url must use https";
  if (url.username !== "" || url.password !== "") return "url must not contain credentials";
  if (isBlockedHostname(url.hostname)) return "url must point at a public host";
  return undefined;
}

export const webhookUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .superRefine((value, ctx) => {
    const problem = webhookUrlProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const eventTypeSchema = z
  .string()
  .max(MAX_EVENT_TYPE_LENGTH)
  .regex(EVENT_TYPE_PATTERN, "event type must look like invoice.paid");

export const eventTypesSchema = z
  .array(eventTypeSchema)
  .min(1)
  .max(MAX_EVENT_TYPES)
  .refine((items) => new Set(items).size === items.length, "event types must be unique");

export const descriptionSchema = z.string().max(MAX_DESCRIPTION_LENGTH);

export const endpointStatusSchema = z.enum(["active", "disabled"]);

export const createWebhookEndpointSchema = z.strictObject({
  url: webhookUrlSchema,
  eventTypes: eventTypesSchema,
  description: descriptionSchema.optional(),
});

// every field is optional, but an empty patch is almost certainly a client bug
export const updateWebhookEndpointSchema = z
  .strictObject({
    url: webhookUrlSchema.optional(),
    eventTypes: eventTypesSchema.optional(),
    // null clears the description
    description: descriptionSchema.nullable().optional(),
    status: endpointStatusSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "send at least one field to update");

export const listWebhookEndpointsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.uuid().optional(),
});

export const webhookEndpointSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  status: endpointStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

// the secret is only ever returned once, on create
export const createdWebhookEndpointSchema = webhookEndpointSchema.extend({
  signingSecret: z.string(),
});

export const webhookEndpointListSchema = z.object({
  data: z.array(webhookEndpointSchema),
  nextCursor: z.uuid().nullable(),
});

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;
export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointSchema>;
export type ListWebhookEndpointsQuery = z.infer<typeof listWebhookEndpointsQuerySchema>;
export type EndpointStatus = z.infer<typeof endpointStatusSchema>;
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;
export type CreatedWebhookEndpoint = z.infer<typeof createdWebhookEndpointSchema>;
export type WebhookEndpointList = z.infer<typeof webhookEndpointListSchema>;
