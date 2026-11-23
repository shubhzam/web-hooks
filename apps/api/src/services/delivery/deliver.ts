import { config } from "../../config.js";
import { describeError } from "../../lib/describe-error.js";
import { recordFailure, recordSuccess } from "./breaker.js";
import { describeFailure } from "./failure.js";
import type { DeliveryHttpClient } from "./http-client.js";
import { buildBody, signPayload } from "./payload.js";
import {
  recordOutcome,
  releaseDelivery,
  tripBreaker,
  type AttemptFields,
  type ClaimedDelivery,
  type DeliveryContext,
  type Verdict,
  type WriteResult,
} from "./repository.js";
import { decideRetry, parseRetryAfter, positionOf, type RetryPolicy } from "./retry.js";

export interface DeliveryJob {
  claimed: ClaimedDelivery;
  context: DeliveryContext;
}

// what the request itself produced, before the retry decision
type SentAttempt = AttemptFields & { retryAfterMs: number | null };

// a finished attempt: the facts for the attempt row, what happens to the delivery, and the wait
// when it is a retry (kept for the log line)
type AttemptResult = AttemptFields & Verdict & { delayMs: number | null };

type Step = { kind: "release"; notBefore: Date } | { kind: "attempt"; result: AttemptResult };

type SkipReason = "endpoint_inactive" | "max_age_exceeded";

const policy: RetryPolicy = {
  delaysMs: config.deliveryRetryDelaysMs,
  jitter: config.deliveryRetryJitter,
  retryAfterMaxMs: config.deliveryRetryAfterMaxMs,
  maxAttempts: config.deliveryMaxAttempts,
};

// failures that say nothing about the health of the endpoint, they never feed the breaker
const BREAKER_EXEMPT_ERRORS = new Set(["blocked_address", "endpoint_inactive", "max_age_exceeded"]);

// the host only, a full url can carry a path or a token that must not reach the logs
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

function skipReason(job: DeliveryJob): SkipReason | null {
  const { endpoint, cycleStartedAt } = job.context;
  if (endpoint.status !== "active" || endpoint.deletedAt !== null) return "endpoint_inactive";
  if (Date.now() - cycleStartedAt.getTime() > config.deliveryMaxAgeMs) return "max_age_exceeded";
  return null;
}

function skippedAttempt(error: SkipReason): AttemptResult {
  return { outcome: "exhausted", startedAt: new Date(), durationMs: 0, responseStatus: null, error, delayMs: null };
}

// when the endpoint is paused, the moment this delivery may be tried again: after the pause, at a
// random point in the spread window. null when there is no pause to wait for
function releaseTime(job: DeliveryJob): Date | null {
  const pausedUntil = job.context.endpoint.pausedUntil;
  if (!pausedUntil || pausedUntil.getTime() <= Date.now()) return null;
  return new Date(pausedUntil.getTime() + Math.random() * config.circuitReleaseSpreadMs);
}

// never throws: every failure of the request itself becomes a short code
async function sendRequest(job: DeliveryJob, client: DeliveryHttpClient): Promise<SentAttempt> {
  const startedAt = new Date();
  try {
    const { deliveryId, event, endpoint } = job.context;
    const body = buildBody(event);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = signPayload(deliveryId, timestampSeconds, body, endpoint.signingSecret);
    const response = await client.send({ url: endpoint.url, deliveryId, timestampSeconds, body, signature });
    const ok = response.status >= 200 && response.status < 300;
    return {
      startedAt,
      durationMs: response.durationMs,
      responseStatus: response.status,
      error: ok ? null : `http_${response.status}`,
      retryAfterMs: parseRetryAfter(response.retryAfter, Date.now()),
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt.getTime();
    return { startedAt, durationMs, responseStatus: null, error: describeFailure(err), retryAfterMs: null };
  }
}

function toResult(job: DeliveryJob, sent: SentAttempt): AttemptResult {
  const position = positionOf(job.claimed.attemptCount, job.claimed.replayBase);
  const decision = decideRetry(sent, position, policy);
  const { startedAt, durationMs, responseStatus, error } = sent;
  const fields = { startedAt, durationMs, responseStatus, error };
  if (decision.kind === "retry") {
    return { ...fields, outcome: "retry", nextAttemptAt: new Date(Date.now() + decision.delayMs), delayMs: decision.delayMs };
  }
  return { ...fields, outcome: decision.kind, delayMs: null };
}

// the checks that need no request, in order: inactive endpoint, too old, paused endpoint
async function plan(job: DeliveryJob, client: DeliveryHttpClient): Promise<Step> {
  const skip = skipReason(job);
  if (skip) return { kind: "attempt", result: skippedAttempt(skip) };
  const notBefore = releaseTime(job);
  if (notBefore) return { kind: "release", notBefore };
  return { kind: "attempt", result: toResult(job, await sendRequest(job, client)) };
}

function logPrefix(job: DeliveryJob): string {
  return `delivery id=${job.claimed.id} host=${hostOf(job.context.endpoint.url)} attempt=${job.claimed.attemptCount}`;
}

function logAttempt(job: DeliveryJob, result: AttemptResult, written: WriteResult): void {
  if (written === "lease_lost") {
    console.warn(`${logPrefix(job)} outcome=lease_lost result dropped`);
    return;
  }
  const next = result.delayMs === null ? "" : ` nextInMs=${result.delayMs}`;
  const error = result.error ? ` error=${result.error}` : "";
  console.log(
    `${logPrefix(job)} outcome=${result.outcome}${next} status=${result.responseStatus ?? "none"} durationMs=${result.durationMs ?? 0}${error}`,
  );
}

async function trip(job: DeliveryJob): Promise<void> {
  const tripped = await tripBreaker(job.claimed.endpointId);
  if (!tripped) return;
  const host = hostOf(job.context.endpoint.url);
  console.log(`circuit_open host=${host} pausedUntil=${tripped.pausedUntil.toISOString()} deferred=${tripped.deferred}`);
}

// counts the result against the endpoint and opens the circuit at the threshold. never throws,
// a breaker problem must not undo an attempt that is already recorded
async function updateBreaker(job: DeliveryJob, result: AttemptResult): Promise<void> {
  try {
    const { endpointId } = job.claimed;
    if (result.outcome === "succeeded") {
      await recordSuccess(endpointId);
      return;
    }
    if (result.error !== null && BREAKER_EXEMPT_ERRORS.has(result.error)) return;
    const failures = await recordFailure(endpointId);
    if (failures !== null && failures >= config.circuitFailureThreshold) await trip(job);
  } catch (err) {
    console.error(`delivery id=${job.claimed.id} breaker update failed: ${describeError(err)}`);
  }
}

async function settle(job: DeliveryJob, result: AttemptResult): Promise<void> {
  const written = await recordOutcome({
    deliveryId: job.claimed.id,
    attemptNumber: job.claimed.attemptCount,
    ...result,
  });
  logAttempt(job, result, written);
  if (written === "recorded") await updateBreaker(job, result);
}

async function release(job: DeliveryJob, notBefore: Date): Promise<void> {
  const written = await releaseDelivery(job.claimed.id, job.claimed.attemptCount, notBefore);
  if (written === "lease_lost") {
    console.warn(`${logPrefix(job)} outcome=lease_lost release dropped`);
    return;
  }
  console.log(`${logPrefix(job)} outcome=released nextInMs=${Math.max(0, notBefore.getTime() - Date.now())}`);
}

// one attempt, start to finish. it never throws, so a slot in the worker is always released.
// if the outcome cannot be written (database down) the row stays in_progress and the reaper
// picks it up once the lease runs out
export async function deliver(job: DeliveryJob, client: DeliveryHttpClient): Promise<void> {
  try {
    const step = await plan(job, client);
    if (step.kind === "release") await release(job, step.notBefore);
    else await settle(job, step.result);
  } catch (err) {
    console.error(`delivery id=${job.claimed.id} outcome not recorded, left to lease recovery: ${describeError(err)}`);
  }
}
