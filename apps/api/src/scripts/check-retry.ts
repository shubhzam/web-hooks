import { Config } from "../config.js";
import {
  decideRetry,
  nextDelay,
  parseRetryAfter,
  positionOf,
  type AttemptSummary,
  type RetryDecision,
  type RetryPolicy,
} from "../services/delivery/retry.js";
import { SmokeFailure, check } from "./smoke-kit.js";

// usage: pnpm --filter api check:retry (no stack needed)
// table checks of the retry rules. the policy below is the default one from the techspec, built by
// hand so the checks do not depend on what the environment overrides

const HOUR_MS = 3600 * 1000;
const DELAYS_MS = [5000, 30000, 120000, 600000, 1800000, 7200000, 21600000];
const POLICY: RetryPolicy = { delaysMs: DELAYS_MS, jitter: 0.2, retryAfterMaxMs: 6 * HOUR_MS, maxAttempts: 8 };
const MIDDLE = () => 0.5;
const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

// just enough env for the config class to accept, none of these values is used for anything
const BASE_ENV = {
  DATABASE_URL: "postgresql://placeholder",
  REDIS_URL: "redis://placeholder",
  KAFKA_BROKERS: "placeholder:9092",
  INGEST_API_TOKEN: "x".repeat(32),
};

function status(code: number, retryAfterMs: number | null = null): AttemptSummary {
  return { responseStatus: code, error: code >= 200 && code < 300 ? null : `http_${code}`, retryAfterMs };
}

function failure(error: string): AttemptSummary {
  return { responseStatus: null, error, retryAfterMs: null };
}

function decide(result: AttemptSummary, position = 1): RetryDecision {
  return decideRetry(result, position, POLICY, MIDDLE);
}

function withinJitter(value: number, base: number): boolean {
  return value >= base * 0.8 && value <= base * 1.2;
}

function checkClassification(): void {
  for (const code of [200, 204]) check(`${code} is succeeded`, decide(status(code)).kind === "succeeded");
  check("a 2xx on the last position is still succeeded", decideRetry(status(200), 8, POLICY).kind === "succeeded");

  check("410 is exhausted at once", decide(status(410)).kind === "exhausted");
  for (const error of ["blocked_address", "endpoint_inactive", "max_age_exceeded"]) {
    check(`${error} is exhausted at once`, decide(failure(error)).kind === "exhausted");
  }

  for (const code of [404, 401, 500, 502, 503, 429, 408, 301]) {
    check(`${code} is retried`, decide(status(code)).kind === "retry");
  }
  for (const error of ["timeout", "network_error", "dns_error", "tls_error", "connection_refused"]) {
    check(`${error} is retried`, decide(failure(error)).kind === "retry");
  }

  const seventh = decideRetry(status(500), 7, POLICY);
  check(
    "position 7 failing is retried with the 6 hour delay within 20 percent",
    seventh.kind === "retry" && withinJitter(seventh.delayMs, 6 * HOUR_MS),
    JSON.stringify(seventh),
  );
  check("position 8 failing is exhausted", decideRetry(status(500), 8, POLICY).kind === "exhausted");
  check("a network failure on position 8 is exhausted too", decideRetry(failure("timeout"), 8, POLICY).kind === "exhausted");
}

function checkJitter(): void {
  DELAYS_MS.forEach((base, index) => {
    const low = nextDelay(index + 1, null, POLICY, 0);
    const high = nextDelay(index + 1, null, POLICY, 1);
    const middle = nextDelay(index + 1, null, POLICY, 0.5);
    check(
      `delay ${index + 1} stays within 20 percent of ${base} ms`,
      low === Math.round(base * 0.8) && high === Math.round(base * 1.2) && middle === base,
      `got ${low}, ${middle}, ${high}`,
    );
  });
}

function checkRetryAfter(): void {
  check("a Retry-After longer than the schedule wins", nextDelay(1, 120000, POLICY, 0.5) === 120000);
  check("a Retry-After shorter than the schedule loses", nextDelay(3, 10000, POLICY, 0.5) === 120000);
  check("a Retry-After above the cap is capped", nextDelay(1, 10 * HOUR_MS, POLICY, 0.5) === 6 * HOUR_MS);
  check("the cap never shortens the schedule itself", nextDelay(7, 10 * HOUR_MS, POLICY, 1) === Math.round(6 * HOUR_MS * 1.2));

  const retryAfterDelay = (code: number) => {
    const decision = decide(status(code, 120000));
    return decision.kind === "retry" ? decision.delayMs : -1;
  };
  check("a 503 honors Retry-After", retryAfterDelay(503) === 120000);
  check("a 429 honors Retry-After", retryAfterDelay(429) === 120000);
  for (const code of [500, 502, 404, 408, 301]) {
    check(`a ${code} ignores Retry-After`, retryAfterDelay(code) === 5000, `got ${retryAfterDelay(code)}`);
  }
}

function checkParseRetryAfter(): void {
  check('"120" is 120000 ms', parseRetryAfter("120", NOW_MS) === 120000);
  const future = new Date(NOW_MS + 90000).toUTCString();
  check("a future http date is the time until then", parseRetryAfter(future, NOW_MS) === 90000, future);
  const past = new Date(NOW_MS - 90000).toUTCString();
  check("a past http date is 0", parseRetryAfter(past, NOW_MS) === 0, past);
  check('"-5" is 0', parseRetryAfter("-5", NOW_MS) === 0);
  check('"abc" is null', parseRetryAfter("abc", NOW_MS) === null);
  check("a missing header is null", parseRetryAfter(null, NOW_MS) === null);
  check("an empty header is null", parseRetryAfter("", NOW_MS) === null);
  check('"1.5" is null', parseRetryAfter("1.5", NOW_MS) === null);
}

function checkPosition(): void {
  check("position of attempt 3 with no replay is 3", positionOf(3, 0) === 3);
  check("the first attempt after a replay at 8 is position 1", positionOf(9, 8) === 1);
  check("the last attempt after a replay at 8 is position 8", positionOf(16, 8) === 8);
}

function rejectsConfig(env: Record<string, string>): string | null {
  try {
    new Config({ ...BASE_ENV, ...env });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "unknown error";
  }
}

function checkStartup(): void {
  const defaults = new Config(BASE_ENV);
  check(
    "the defaults are 8 attempts and the seven delays from the techspec",
    defaults.deliveryMaxAttempts === 8 && JSON.stringify(defaults.deliveryRetryDelaysMs) === JSON.stringify(DELAYS_MS),
  );
  const short = rejectsConfig({ DELIVERY_RETRY_DELAYS_MS: "1000,2000,3000" });
  check("startup throws when the delay list is shorter than max attempts minus one", short !== null, "it did not throw");
  check("the message names the setting", short?.includes("DELIVERY_RETRY_DELAYS_MS") === true && short.includes("needs at least 7"), short ?? "");
  check("exactly max attempts minus one delays is accepted", rejectsConfig({ DELIVERY_MAX_ATTEMPTS: "4", DELIVERY_RETRY_DELAYS_MS: "1,2,3" }) === null);
  check("a delay list with a non number is rejected", rejectsConfig({ DELIVERY_RETRY_DELAYS_MS: "1000,abc" }) !== null);
}

function main(): void {
  try {
    checkClassification();
    checkJitter();
    checkRetryAfter();
    checkParseRetryAfter();
    checkPosition();
    checkStartup();
    console.log("check retry passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`check retry crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exitCode = 1;
  }
}

main();
