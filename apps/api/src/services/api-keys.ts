import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";

interface GeneratedApiKey {
  key: string;
  keyPrefix: string;
  keyHash: string;
}

// a random 256-bit key does not need a slow hash, and a plain hash gives us one indexed lookup
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const random = randomBytes(config.apiKeyRandomBytes).toString("base64url");
  const key = `${config.apiKeyPrefix}${random}`;
  return { key, keyPrefix: random.slice(0, config.apiKeyDisplayLength), keyHash: hashApiKey(key) };
}

// the full key is returned here and nowhere else, only its hash is stored
export async function createApiKey(organizationId: string) {
  const { key, keyPrefix, keyHash } = generateApiKey();
  const row = await prisma.apiKey.create({
    data: { id: uuidv7(), organizationId, keyPrefix, keyHash },
  });
  return { id: row.id, key, keyPrefix };
}

// null for unknown and revoked keys alike, callers must not tell them apart
export async function findOrganizationIdByKey(key: string): Promise<string | null> {
  const row = await prisma.apiKey.findFirst({
    where: { keyHash: hashApiKey(key), revokedAt: null },
    select: { organizationId: true },
  });
  return row?.organizationId ?? null;
}

export async function revokeApiKey(id: string): Promise<void> {
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
}

// cheap shape check so garbage never reaches the database
export function isWellFormedApiKey(key: string): boolean {
  const randomLength = Math.ceil((config.apiKeyRandomBytes * 4) / 3);
  return new RegExp(`^${config.apiKeyPrefix}[A-Za-z0-9_-]{${randomLength}}$`).test(key);
}
