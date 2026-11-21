import express from "express";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { healthRouter } from "./routes/health.js";

const app = express();
app.use(healthRouter);

const server = app.listen(config.port, () => {
  console.log(`api listening on ${config.port}`);
});

// close connections cleanly on ctrl-c and docker stop
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));