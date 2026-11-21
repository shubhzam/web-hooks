import { prisma } from "../lib/prisma.js";
import { createOrganizationWithKey } from "../services/organizations.js";

// usage: pnpm --filter api create-org "Acme Billing"
async function main(): Promise<number> {
  const name = process.argv.slice(2).join(" ").trim();
  if (!name) {
    console.error("usage: pnpm --filter api create-org <organization name>");
    return 1;
  }
  const { organization, key } = await createOrganizationWithKey(name);
  console.log(`organization: ${organization.name} (${organization.id})`);
  console.log(`api key: ${key}`);
  console.log("this is the only time the full key is shown, store it now");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`create-org failed: ${err instanceof Error ? err.name : "unknown error"}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
