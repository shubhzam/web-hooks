import { uuidv7 } from "uuidv7";
import { prisma } from "../lib/prisma.js";
import { generateApiKey } from "./api-keys.js";

// the organization and its first key are written together, so a failure never leaves an org without a key
export async function createOrganizationWithKey(name: string) {
  const { key, keyPrefix, keyHash } = generateApiKey();
  const organization = await prisma.organization.create({
    data: { id: uuidv7(), name, apiKeys: { create: { id: uuidv7(), keyPrefix, keyHash } } },
  });
  return { organization, key, keyPrefix };
}
