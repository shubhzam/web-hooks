import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../../config.js";
import { describeError } from "../../lib/describe-error.js";
import { redis } from "../../lib/redis.js";

// the failure counters of the circuit breaker. redis is volatile on purpose: losing a counter only
// delays a trip. nothing here ever throws, and when redis is unreachable the breaker does nothing
// and delivery carries on. the shared client has no offline queue, so a stopped redis fails at once

let lastLoggedAt = 0;

function counterKey(endpointId: string): string {
  return `cb:${endpointId}:fails`;
}

// one line a minute at most, otherwise every delivery would log the same outage
function logUnavailable(err: unknown): void {
  const now = Date.now();
  if (now - lastLoggedAt < config.circuitRedisLogIntervalMs) return;
  lastLoggedAt = now;
  console.warn(`breaker redis unavailable, failures are not counted: ${describeError(err)}`);
}

// a connection that is up but not answering would hold a delivery slot, so every call is bounded
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("redis call timed out")), config.circuitRedisTimeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function countFrom(results: [Error | null, unknown][] | null): number {
  const [error, value] = results?.[0] ?? [];
  if (error || typeof value !== "number") throw new Error("redis returned no count");
  return value;
}

// counts one more failure for the endpoint and returns the new total, or null if redis failed
export async function recordFailure(endpointId: string): Promise<number | null> {
  const key = counterKey(endpointId);
  try {
    // incr and expire together, so a counter never lives without a ttl
    return countFrom(await bounded(redis.multi().incr(key).expire(key, config.circuitCounterTtlS).exec()));
  } catch (err) {
    logUnavailable(err);
    return null;
  }
}

// a success ends the run of failures
export async function recordSuccess(endpointId: string): Promise<void> {
  try {
    await bounded(redis.del(counterKey(endpointId)));
  } catch (err) {
    logUnavailable(err);
  }
}

// for worker shutdown, gives redis a moment to say goodbye and then drops the connection
export async function closeBreaker(): Promise<void> {
  const closed = redis.quit().then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([closed, sleep(config.circuitRedisCloseMs)]);
  redis.disconnect();
}
