// pure: no io. the clock and the random source are passed in, so every rule here can be checked
// with a table

export interface RetryPolicy {
  // wait after failure n is entry n of this list, before jitter
  delaysMs: readonly number[];
  jitter: number;
  retryAfterMaxMs: number;
  maxAttempts: number;
}

// what one attempt produced. error is a short code such as timeout or http_500, never a message
export interface AttemptSummary {
  responseStatus: number | null;
  error: string | null;
  // the parsed Retry-After in milliseconds, null when the header was missing or unreadable
  retryAfterMs: number | null;
}

export type RetryDecision = { kind: "succeeded" } | { kind: "retry"; delayMs: number } | { kind: "exhausted" };

const TERMINAL_ERRORS = new Set(["blocked_address", "endpoint_inactive", "max_age_exceeded"]);
const TERMINAL_STATUS = 410;
// the only statuses where Retry-After means "come back later"
const RETRY_AFTER_STATUSES = new Set([429, 503]);
const HTTP_DATE_PATTERN = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// 1 for the first attempt of a delivery, and again for the first attempt after a replay
export function positionOf(attemptCount: number, replayBase: number): number {
  return attemptCount - replayBase;
}

// integer seconds or an http date. a negative value or a date in the past means "now", so 0.
// anything else is null, and the normal schedule applies
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  const value = header?.trim() ?? "";
  if (/^-?\d+$/.test(value)) return Math.max(0, Number(value) * 1000);
  if (!HTTP_DATE_PATTERN.test(value)) return null;
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - nowMs);
}

function scheduledDelay(position: number, policy: RetryPolicy, random: number): number {
  const index = Math.min(Math.max(position, 1), policy.delaysMs.length) - 1;
  const base = policy.delaysMs[index] ?? 0;
  return base * (1 + (random * 2 - 1) * policy.jitter);
}

// the wait before the next attempt. a server asked wait is honored when it is longer than the
// schedule, but only up to the cap
export function nextDelay(position: number, retryAfterMs: number | null, policy: RetryPolicy, random: number): number {
  const scheduled = scheduledDelay(position, policy, random);
  const requested = retryAfterMs === null ? 0 : Math.min(retryAfterMs, policy.retryAfterMaxMs);
  return Math.round(Math.max(scheduled, requested));
}

function isSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

function isTerminal(result: AttemptSummary): boolean {
  return (result.error !== null && TERMINAL_ERRORS.has(result.error)) || result.responseStatus === TERMINAL_STATUS;
}

export function decideRetry(
  result: AttemptSummary,
  position: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): RetryDecision {
  if (isSuccess(result.responseStatus)) return { kind: "succeeded" };
  if (isTerminal(result) || position >= policy.maxAttempts) return { kind: "exhausted" };
  const honored = result.responseStatus !== null && RETRY_AFTER_STATUSES.has(result.responseStatus);
  return { kind: "retry", delayMs: nextDelay(position, honored ? result.retryAfterMs : null, policy, random()) };
}
