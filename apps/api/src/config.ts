import * as z from "zod";

// "5000,30000" becomes [5000, 30000], anything that is not a positive whole number fails validation
const delayListSchema = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map(Number),
  )
  .pipe(z.array(z.number().int().positive()).min(1));

const baseSchema = z.object({
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
  DELIVERY_CONCURRENCY: z.coerce.number().int().positive().default(50),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DELIVERY_LEASE_MS: z.coerce.number().int().positive().default(60000),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  // wait before attempt n + 1 is the nth entry, before jitter
  DELIVERY_RETRY_DELAYS_MS: delayListSchema.prefault("5000,30000,120000,600000,1800000,7200000,21600000"),
  // 0.2 means each delay is multiplied by a random factor between 0.8 and 1.2
  DELIVERY_RETRY_JITTER: z.coerce.number().min(0).max(1).default(0.2),
  // a Retry-After above this is cut down to it
  DELIVERY_RETRY_AFTER_MAX_MS: z.coerce.number().int().positive().default(21600000),
  // a delivery older than this since its cycle started is given up without a request
  DELIVERY_MAX_AGE_MS: z.coerce.number().int().positive().default(86400000),
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(20),
  CIRCUIT_COOLDOWN_MS: z.coerce.number().int().positive().default(300000),
  CIRCUIT_COUNTER_TTL_S: z.coerce.number().int().positive().default(3600),
  // paused deliveries are spread over this window after the pause so they do not all go out together
  CIRCUIT_RELEASE_SPREAD_MS: z.coerce.number().int().positive().default(150000),
  DELIVERY_REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  DELIVERY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  DELIVERY_SHUTDOWN_MS: z.coerce.number().int().positive().default(20000),
  // host port of the mock receiver, only the delivery smoke script reads it
  MOCK_RECEIVER_PORT: z.coerce.number().int().positive().default(4000),
  // exact hostnames that may use http and skip the address check, for dev and tests only
  DELIVERY_ALLOW_HOSTS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host !== ""),
    ),
});

// the last attempt has no delay after it, so n attempts need n - 1 delays
const envSchema = baseSchema.superRefine((env, ctx) => {
  const needed = env.DELIVERY_MAX_ATTEMPTS - 1;
  if (env.DELIVERY_RETRY_DELAYS_MS.length < needed) {
    ctx.addIssue({
      code: "custom",
      path: ["DELIVERY_RETRY_DELAYS_MS"],
      message: `DELIVERY_RETRY_DELAYS_MS has ${env.DELIVERY_RETRY_DELAYS_MS.length} delays but DELIVERY_MAX_ATTEMPTS=${env.DELIVERY_MAX_ATTEMPTS} needs at least ${needed}`,
    });
  }
});

// exported so the retry check can build one with its own environment
export class Config {
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
  readonly deliveryConcurrency: number;
  readonly deliveryTimeoutMs: number;
  readonly deliveryLeaseMs: number;
  readonly deliveryMaxAttempts: number;
  readonly deliveryRetryDelaysMs: number[];
  readonly deliveryRetryJitter: number;
  readonly deliveryRetryAfterMaxMs: number;
  readonly deliveryMaxAgeMs: number;
  readonly circuitFailureThreshold: number;
  readonly circuitCooldownMs: number;
  readonly circuitCounterTtlS: number;
  readonly circuitReleaseSpreadMs: number;
  readonly deliveryReaperIntervalMs: number;
  readonly deliveryPollIntervalMs: number;
  readonly deliveryShutdownMs: number;
  readonly deliveryAllowHosts: string[];
  readonly mockReceiverPort: number;

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
  readonly deliveryUserAgent = "webhook-service/1";
  // the response is never stored, so reading more than this would only waste time and memory
  readonly deliveryResponseCapBytes = 64 * 1024;
  // most rows one claim takes, so one slow poll cannot hoard work from the other workers
  readonly deliveryClaimBatchSize = 50;
  readonly deliveryReapBatchSize = 100;
  // pause after a database error in the main loop before it tries again
  readonly deliveryErrorPauseMs = 1000;
  readonly deliveryTxTimeoutMs = 10000;
  readonly deliveryTxMaxWaitMs = 10000;
  // a redis call that takes longer than this counts as a failure, so a hung redis cannot hold a delivery
  readonly circuitRedisTimeoutMs = 1000;
  // a redis problem is logged at most this often, the breaker would otherwise log on every delivery
  readonly circuitRedisLogIntervalMs = 60000;
  // how long the worker waits for redis to close on shutdown
  readonly circuitRedisCloseMs = 2000;
  // the window of the endpoint stats, the shared schema labels it 24h
  readonly deliveryStatsWindowMs = 24 * 60 * 60 * 1000;

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
    this.deliveryConcurrency = result.data.DELIVERY_CONCURRENCY;
    this.deliveryTimeoutMs = result.data.DELIVERY_TIMEOUT_MS;
    this.deliveryLeaseMs = result.data.DELIVERY_LEASE_MS;
    this.deliveryMaxAttempts = result.data.DELIVERY_MAX_ATTEMPTS;
    this.deliveryRetryDelaysMs = result.data.DELIVERY_RETRY_DELAYS_MS;
    this.deliveryRetryJitter = result.data.DELIVERY_RETRY_JITTER;
    this.deliveryRetryAfterMaxMs = result.data.DELIVERY_RETRY_AFTER_MAX_MS;
    this.deliveryMaxAgeMs = result.data.DELIVERY_MAX_AGE_MS;
    this.circuitFailureThreshold = result.data.CIRCUIT_FAILURE_THRESHOLD;
    this.circuitCooldownMs = result.data.CIRCUIT_COOLDOWN_MS;
    this.circuitCounterTtlS = result.data.CIRCUIT_COUNTER_TTL_S;
    this.circuitReleaseSpreadMs = result.data.CIRCUIT_RELEASE_SPREAD_MS;
    this.deliveryReaperIntervalMs = result.data.DELIVERY_REAPER_INTERVAL_MS;
    this.deliveryPollIntervalMs = result.data.DELIVERY_POLL_INTERVAL_MS;
    this.deliveryShutdownMs = result.data.DELIVERY_SHUTDOWN_MS;
    this.deliveryAllowHosts = result.data.DELIVERY_ALLOW_HOSTS;
    this.mockReceiverPort = result.data.MOCK_RECEIVER_PORT;
  }
}

// fails fast at startup if a required variable is missing
export const config = new Config(process.env);