import type { Request, RequestHandler } from "express";
import { unauthorized } from "../lib/errors.js";
import { findOrganizationIdByKey, isWellFormedApiKey } from "../services/api-keys.js";

// keyed by request so handlers get a typed value without touching express's global types
const organizationByRequest = new WeakMap<Request, string>();

const BEARER_PATTERN = /^Bearer (\S+)$/i;

// shared with the ingest token middleware
export function parseBearerToken(header: string | undefined): string | null {
  return header?.match(BEARER_PATTERN)?.[1] ?? null;
}

// missing, malformed, unknown and revoked keys all end in the same 401
export const requireApiKey: RequestHandler = async (req, _res, next) => {
  const key = parseBearerToken(req.headers.authorization);
  const organizationId = key && isWellFormedApiKey(key) ? await findOrganizationIdByKey(key) : null;
  if (!organizationId) throw unauthorized();
  organizationByRequest.set(req, organizationId);
  next();
};

// fails closed: a route mounted without requireApiKey gets a 401 instead of an unscoped query
export function organizationIdOf(req: Request): string {
  const organizationId = organizationByRequest.get(req);
  if (!organizationId) throw unauthorized();
  return organizationId;
}
