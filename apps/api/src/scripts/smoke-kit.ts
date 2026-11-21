import { randomUUID } from "node:crypto";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { config } from "../config.js";

// shared pieces of the smoke scripts: one output line per check, a throwaway topic consumer,
// and a helper to post events

const ASSIGNMENT_WAIT_MS = 10000;

export interface ApiResult {
  status: number;
  text: string;
  json: unknown;
}

export class SmokeFailure extends Error {}

// prints one line and stops the script on the first failed check
export function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) {
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    throw new SmokeFailure(name);
  }
  console.log(`ok   ${name}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(done: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return true;
    await sleep(stepMs);
  }
  return done();
}

export async function postEvent(body: unknown, token?: string): Promise<ApiResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${config.apiUrl}/v1/events`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  return { status: res.status, text, json };
}

export function kafkaClient(clientId: string): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: { brokers: config.kafkaBrokers, clientId, logLevel: KafkaJS.logLevel.ERROR },
    "broker.address.family": "v4",
  });
}

// seeking to the high watermarks makes "start at the end" exact, no matter when the group joined
async function seekToEnd(kafka: KafkaJS.Kafka, consumer: KafkaJS.Consumer, topic: string): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    for (const entry of await admin.fetchTopicOffsets(topic)) {
      consumer.seek({ topic, partition: entry.partition, offset: entry.high });
    }
  } finally {
    await admin.disconnect();
  }
}

export interface TailOptions {
  clientId: string;
  topic: string;
  partitions: number;
  onMessage: (partition: number, message: KafkaJS.KafkaMessage) => void;
}

// a consumer in a unique group that commits nothing and reads only what arrives after it started
export async function startTailConsumer(options: TailOptions): Promise<KafkaJS.Consumer> {
  const kafka = kafkaClient(options.clientId);
  const consumer = kafka.consumer({
    kafkaJS: {
      groupId: `${options.clientId}-${randomUUID()}`,
      fromBeginning: false,
      autoCommit: false,
      logLevel: KafkaJS.logLevel.ERROR,
    },
    "broker.address.family": "v4",
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [options.topic] });
  await consumer.run({
    eachMessage: async ({ partition, message }) => {
      options.onMessage(partition, message);
    },
  });
  const assigned = await waitUntil(() => consumer.assignment().length === options.partitions, ASSIGNMENT_WAIT_MS);
  check(
    `throwaway consumer is assigned all ${options.partitions} partition(s) of ${options.topic}`,
    assigned,
    `assigned ${consumer.assignment().length}`,
  );
  await seekToEnd(kafka, consumer, options.topic);
  return consumer;
}
