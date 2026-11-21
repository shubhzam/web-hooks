import { config } from "./config.js";
import { startConsumer, stopConsumer } from "./lib/consumer.js";
import { connectProducer, disconnect as disconnectKafka } from "./lib/kafka.js";
import { prisma } from "./lib/prisma.js";
import type { SourceMessage } from "./services/fanout.js";
import { processBatch } from "./services/process-batch.js";

// reads webhook.events and turns every event into one pending delivery per matching endpoint.
// there is no http server here, so there is no /health for this process

async function handleBatch(messages: SourceMessage[]): Promise<void> {
  const startedAt = performance.now();
  const result = await processBatch(messages);
  const durationMs = Math.round(performance.now() - startedAt);
  const first = messages[0];
  const last = messages.at(-1);
  const dlq = result.poison > 0 ? ` dlq=${result.poison}` : "";
  console.log(
    `batch partition=${first?.partition} offsets=${first?.offset}-${last?.offset} ` +
      `events=${result.events} deliveries=${result.deliveries} durationMs=${durationMs}${dlq}`,
  );
}

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, finishing the current batch`);
  await stopConsumer().catch((err: unknown) => {
    console.error(`consumer stop failed: ${err instanceof Error ? err.message : "unknown error"}`);
  });
  await Promise.allSettled([disconnectKafka(), prisma.$disconnect()]);
  console.log("processor stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// the dlq producer and the consumer both connect in the background and keep retrying, and
// postgres is only touched when a batch arrives, so none of them can stop the process from booting
console.log(`processor starting group=${config.kafkaConsumerGroup} batchSize=${config.processorBatchSize}`);
connectProducer();
startConsumer(handleBatch);
