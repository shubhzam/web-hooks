import express from "express";
import { config } from "./config.js";
import { connectProducer, disconnect as disconnectKafka } from "./lib/kafka.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { requireApiKey } from "./middleware/auth.js";
import { requireIngestToken } from "./middleware/ingest-auth.js";
import { errorHandler, routeNotFound } from "./middleware/error.js";
import { eventsRouter } from "./routes/events.js";
import { deliveriesRouter } from "./routes/deliveries.js";
import { healthRouter } from "./routes/health.js";
import { webhookEndpointsRouter } from "./routes/webhook-endpoints.js";

const app = express();
app.use(healthRouter);

// internal event route first, it has its own token and customer keys must not reach it
app.use("/v1/events", requireIngestToken, eventsRouter);

// auth runs before the body is parsed, so anonymous callers never make us read a large body
app.use("/v1", requireApiKey, express.json({ limit: config.jsonBodyLimit }), webhookEndpointsRouter, deliveriesRouter);

// these two stay last, express only treats a handler as an error handler by position and arity
app.use(routeNotFound);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`api listening on ${config.port}`);
});

// kafka connects in the background, registration keeps working while the broker is down
connectProducer();

// close connections cleanly on ctrl-c and docker stop
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit(), disconnectKafka()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));