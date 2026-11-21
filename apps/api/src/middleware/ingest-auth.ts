import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "../config.js";
import { unauthorized } from "../lib/errors.js";
import { parseBearerToken } from "./auth.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

const expectedDigest = digest(config.ingestApiToken);

// hashing both sides gives equal length buffers, so timingSafeEqual never throws and length does not leak
function matchesIngestToken(candidate: string): boolean {
  return timingSafeEqual(digest(candidate), expectedDigest);
}

// guards the internal event route only, customer api keys fail this check like any wrong token
export const requireIngestToken: RequestHandler = (req, _res, next) => {
  const token = parseBearerToken(req.headers.authorization);
  if (!token || !matchesIngestToken(token)) throw unauthorized();
  next();
};
