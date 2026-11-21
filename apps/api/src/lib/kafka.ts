import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { EventEnvelope } from "@repo/shared/event";
import { config } from "../config.js";

// thrown for every way a publish can fail: not connected, send error, ack timeout
export class BrokerUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrokerUnavailableError";
  }
}

let producer: KafkaJS.Producer | null = null;
let admin: KafkaJS.Admin | null = null;
let stopping = false;

function describe(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  return "code" in err ? `${err.message} (code ${String(err.code)})` : err.message;
}

function createProducer(): KafkaJS.Producer {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: config.kafkaBrokers, clientId: config.kafkaClientId },
  });
  return kafka.producer({
    kafkaJS: {
      acks: -1,
      idempotent: true,
      logLevel: KafkaJS.logLevel.WARN,
    },
    // the ack timeout in the kafkajs block is enforced by the broker only. this is librdkafka's
    // end to end limit for one message, retries included. without it a message queued during an
    // outage could still be delivered long after we answered 503, and the client would retry it
    "message.timeout.ms": config.kafkaSendTimeoutMs,
    // compose publishes the host port on 127.0.0.1 only, so skip the ::1 attempt for localhost
    "broker.address.family": "v4",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// connect() retries on its own and then gives up, and a failed instance is unusable, so each
// round builds a fresh producer
async function connectWithBackoff(): Promise<void> {
  let delayMs = config.kafkaConnectRetryInitialMs;
  while (!stopping) {
    const candidate = createProducer();
    try {
      await candidate.connect();
      if (stopping) {
        await candidate.disconnect();
        return;
      }
      producer = candidate;
      console.log(`kafka producer connected to ${config.kafkaBrokers.join(",")}`);
      return;
    } catch (err) {
      console.error(`kafka connect failed, retrying in ${delayMs}ms: ${describe(err)}`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, config.kafkaConnectRetryMaxMs);
    }
  }
}

// starts in the background and returns right away, a dead broker must not block or crash the api
export function connectProducer(): void {
  connectWithBackoff().catch((err: unknown) => {
    console.error(`kafka connect loop stopped: ${describe(err)}`);
  });
}

export function isConnected(): boolean {
  return producer !== null && !stopping;
}

// a fatal producer error (a rare idempotence failure) makes the instance unusable, so replace it
async function replaceProducer(): Promise<void> {
  const broken = producer;
  producer = null;
  admin = null;
  connectProducer();
  await broken?.disconnect().catch(() => undefined);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no ack within ${ms}ms`)), ms);
  });
  // if the timeout wins, a late failure of the send must not turn into an unhandled rejection
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function isFatal(err: unknown): boolean {
  return err instanceof Error && "fatal" in err && err.fatal === true;
}

async function send(topic: string, message: KafkaJS.Message): Promise<void> {
  const active = producer;
  if (!active || stopping) throw new BrokerUnavailableError("kafka producer is not connected");
  try {
    await withTimeout(active.send({ topic, messages: [message] }), config.kafkaSendTimeoutMs);
  } catch (err) {
    console.error(`kafka publish failed: ${describe(err)}`);
    if (isFatal(err)) await replaceProducer();
    throw new BrokerUnavailableError("kafka publish failed", { cause: err });
  }
}

// resolves only after the broker acked the write, never logs the envelope
export async function publish(envelope: EventEnvelope): Promise<void> {
  await send(config.kafkaTopic, { key: envelope.eventId, value: JSON.stringify(envelope) });
}

// sends bytes as they are, used to copy a message we could not parse to the dlq
export async function publishRaw(topic: string, message: KafkaJS.Message): Promise<void> {
  await send(topic, message);
}

// asks the broker for topic metadata over the producer's own connection, used by /health
export async function checkBroker(timeoutMs: number): Promise<void> {
  const active = producer;
  if (!active) throw new BrokerUnavailableError("kafka producer is not connected");
  if (!admin) {
    const created = active.dependentAdmin();
    await created.connect();
    admin = created;
  }
  await admin.fetchTopicMetadata({ topics: [config.kafkaTopic], timeout: timeoutMs });
}

export async function disconnect(): Promise<void> {
  stopping = true;
  const active = producer;
  producer = null;
  admin = null;
  await active?.disconnect();
}
