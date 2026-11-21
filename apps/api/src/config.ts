import * as z from "zod";

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
  // where the smoke scripts send their requests
  API_URL: z.url().default("http://localhost:3001"),
  // comma separated host:port list
  KAFKA_BROKERS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker !== ""),
    )
    .pipe(z.array(z.string()).min(1)),
  KAFKA_CLIENT_ID: z.string().min(1).default("webhooks-api"),
  KAFKA_TOPIC: z.string().min(1).default("webhook.events"),
  KAFKA_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  // one static token shared by the internal apps that post events
  INGEST_API_TOKEN: z.string().min(32),
  // 256 KB, the payload limit from the techspec
  INGEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(262144),
  KAFKA_CONSUMER_GROUP: z.string().min(1).default("event-processor"),
  KAFKA_DLQ_TOPIC: z.string().min(1).default("webhook.events.dlq"),
  PROCESSOR_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  PROCESSOR_BATCH_WAIT_MS: z.coerce.number().int().positive().default(200),
  PROCESSOR_RETRY_MAX_MS: z.coerce.number().int().positive().default(30000),
});

class Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly healthTimeoutMs: number;
  readonly apiUrl: string;
  readonly kafkaBrokers: string[];
  readonly kafkaClientId: string;
  readonly kafkaTopic: string;
  readonly kafkaSendTimeoutMs: number;
  readonly ingestApiToken: string;
  readonly ingestBodyLimitBytes: number;
  readonly kafkaConsumerGroup: string;
  readonly kafkaDlqTopic: string;
  readonly processorBatchSize: number;
  readonly processorBatchWaitMs: number;
  readonly processorRetryMaxMs: number;

  // fixed settings, these are not read from the environment
  readonly apiKeyPrefix = "whk_live_";
  readonly apiKeyRandomBytes = 32;
  // how much of the random part is kept in plain text so a key can be recognised in a ui
  readonly apiKeyDisplayLength = 8;
  readonly signingSecretPrefix = "whsec_";
  readonly signingSecretRandomBytes = 32;
  readonly jsonBodyLimit = "100kb";
  // pause between attempts while the broker is unreachable, doubles up to the max
  readonly kafkaConnectRetryInitialMs = 1000;
  readonly kafkaConnectRetryMaxMs = 15000;
  // the batch transaction can hold a few thousand rows, so it gets more than prisma's default 5s
  readonly processorTxTimeoutMs = 30000;
  readonly processorTxMaxWaitMs = 10000;
  // rows per deliveries insert, keeps one statement far below the bind parameter limit
  readonly deliveryChunkSize = 1000;
  readonly processorRetryInitialMs = 1000;

  constructor(env: NodeJS.ProcessEnv) {
    const result = envSchema.safeParse(env);
    if (!result.success) {
      throw new Error(`invalid environment\n${z.prettifyError(result.error)}`);
    }
    this.port = result.data.API_PORT;
    this.databaseUrl = result.data.DATABASE_URL;
    this.redisUrl = result.data.REDIS_URL;
    this.healthTimeoutMs = result.data.HEALTH_TIMEOUT_MS;
    this.apiUrl = result.data.API_URL;
    this.kafkaBrokers = result.data.KAFKA_BROKERS;
    this.kafkaClientId = result.data.KAFKA_CLIENT_ID;
    this.kafkaTopic = result.data.KAFKA_TOPIC;
    this.kafkaSendTimeoutMs = result.data.KAFKA_SEND_TIMEOUT_MS;
    this.ingestApiToken = result.data.INGEST_API_TOKEN;
    this.ingestBodyLimitBytes = result.data.INGEST_BODY_LIMIT_BYTES;
    this.kafkaConsumerGroup = result.data.KAFKA_CONSUMER_GROUP;
    this.kafkaDlqTopic = result.data.KAFKA_DLQ_TOPIC;
    this.processorBatchSize = result.data.PROCESSOR_BATCH_SIZE;
    this.processorBatchWaitMs = result.data.PROCESSOR_BATCH_WAIT_MS;
    this.processorRetryMaxMs = result.data.PROCESSOR_RETRY_MAX_MS;
  }
}

// fails fast at startup if a required variable is missing
export const config = new Config(process.env);