import { setTimeout as sleep } from "node:timers/promises";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { config } from "../config.js";
import type { SourceMessage } from "../services/fanout.js";
import { describeError } from "./describe-error.js";

// the handler must be safe to run twice on the same messages, a retry or a replay will do exactly that
export type BatchHandler = (messages: SourceMessage[]) => Promise<void>;

let consumer: KafkaJS.Consumer | null = null;
// aborted on shutdown, it wakes every sleep and ends every retry loop
const shutdown = new AbortController();

function isStopping(): boolean {
  return shutdown.signal.aborted;
}

async function pause(ms: number): Promise<void> {
  await sleep(ms, undefined, { signal: shutdown.signal }).catch(() => undefined);
}

function nextDelay(delayMs: number): number {
  return Math.min(delayMs * 2, config.processorRetryMaxMs);
}

function createConsumer(): KafkaJS.Consumer {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: config.kafkaBrokers,
      clientId: `${config.kafkaClientId}-processor`,
      logLevel: KafkaJS.logLevel.WARN,
    },
  });
  return kafka.consumer({
    kafkaJS: {
      groupId: config.kafkaConsumerGroup,
      // a group with no committed offset starts at the beginning of the topic
      fromBeginning: true,
      // offsets are committed by hand, only after the batch is safely in postgres
      autoCommit: false,
      // how long the broker may hold a fetch while it waits for data
      maxWaitTimeInMs: config.processorBatchWaitMs,
      logLevel: KafkaJS.logLevel.WARN,
    },
    // upper bound of one eachBatch call, the library builds these batches itself
    "js.consumer.max.batch.size": config.processorBatchSize,
    "broker.address.family": "v4",
  });
}

function toSourceMessages(batch: KafkaJS.Batch): SourceMessage[] {
  return batch.messages.map((message) => ({
    topic: batch.topic,
    partition: batch.partition,
    offset: message.offset,
    key: message.key,
    value: message.value,
  }));
}

function describeBatch(messages: SourceMessage[]): string {
  const first = messages[0];
  const last = messages.at(-1);
  return `partition=${first?.partition} offsets=${first?.offset}-${last?.offset}`;
}

// retries the same batch with a growing pause. returns false only when shutdown stopped it,
// in which case nothing was committed and the batch will be read again later
async function retryUntilDone(work: () => Promise<void>, label: string): Promise<boolean> {
  let delayMs = config.processorRetryInitialMs;
  while (!isStopping()) {
    try {
      await work();
      return true;
    } catch (err) {
      console.error(`batch failed ${label}, retrying in ${delayMs}ms: ${describeError(err)}`);
      await pause(delayMs);
      delayMs = nextDelay(delayMs);
    }
  }
  return false;
}

// resolveOffset only stores "next offset to read" inside the client. commitOffsets is the call
// that tells the broker. the commit names the next offset, the highest one in the batch plus 1
async function commitBatch(
  active: KafkaJS.Consumer,
  payload: KafkaJS.EachBatchPayload,
  messages: SourceMessage[],
): Promise<void> {
  const last = messages.at(-1);
  if (!last) return;
  // a rebalance took the partition while we worked, the new owner reads it again and the
  // database absorbs the repeat
  if (payload.isStale()) {
    console.warn(`batch stale after processing ${describeBatch(messages)}, offsets not committed`);
    return;
  }
  payload.resolveOffset(last.offset);
  const next = (BigInt(last.offset) + 1n).toString();
  try {
    await active.commitOffsets([{ topic: last.topic, partition: last.partition, offset: next }]);
  } catch (err) {
    // the rows are already saved, so the worst case is a replay that inserts nothing
    console.error(`offset commit failed ${describeBatch(messages)}: ${describeError(err)}`);
  }
}

// never throws: if eachBatch throws, the library logs the whole error with its stack, and a
// prisma error message can carry query arguments
async function onBatch(
  active: KafkaJS.Consumer,
  payload: KafkaJS.EachBatchPayload,
  handler: BatchHandler,
): Promise<void> {
  const messages = toSourceMessages(payload.batch);
  const done = await retryUntilDone(() => handler(messages), describeBatch(messages));
  if (done) await commitBatch(active, payload, messages);
}

async function startWithBackoff(handler: BatchHandler): Promise<void> {
  let delayMs = config.kafkaConnectRetryInitialMs;
  while (!isStopping()) {
    const candidate = createConsumer();
    try {
      await candidate.connect();
      await candidate.subscribe({ topics: [config.kafkaTopic] });
      consumer = candidate;
      await candidate.run({
        // the batch is resolved by hand in commitBatch, and only after it succeeded
        eachBatchAutoResolve: false,
        eachBatch: (payload) => onBatch(candidate, payload, handler),
      });
      console.log(`consumer started group=${config.kafkaConsumerGroup} topic=${config.kafkaTopic}`);
      return;
    } catch (err) {
      console.error(`consumer start failed, retrying in ${delayMs}ms: ${describeError(err)}`);
      await candidate.disconnect().catch(() => undefined);
      await pause(delayMs);
      delayMs = Math.min(delayMs * 2, config.kafkaConnectRetryMaxMs);
    }
  }
}

// starts in the background and returns right away, a dead broker must not crash the process
export function startConsumer(handler: BatchHandler): void {
  startWithBackoff(handler).catch((err: unknown) => {
    console.error(`consumer start loop stopped: ${describeError(err)}`);
  });
}

// ends the retry loops first, then disconnect waits for the batch that is running right now
export async function stopConsumer(): Promise<void> {
  shutdown.abort();
  await consumer?.disconnect();
}
