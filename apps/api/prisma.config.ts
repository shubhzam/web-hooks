import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// repo root .env is the single source of env, package scripts run with cwd = apps/api
config({ path: "../../.env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // generate does not need a url, so docker builds work without one
  datasource: { url: process.env["DATABASE_URL"] },
});