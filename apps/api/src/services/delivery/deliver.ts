import { describeError } from "../../lib/describe-error.js";
import { describeFailure } from "./failure.js";
import type { DeliveryHttpClient } from "./http-client.js";
import { buildBody, signPayload } from "./payload.js";
import { recordOutcome, type ClaimedDelivery, type DeliveryContext, type Outcome } from "./repository.js";

export interface DeliveryJob {
  claimed: ClaimedDelivery;
  context: DeliveryContext;
}

interface AttemptResult {
  outcome: Outcome;
  startedAt: Date;
  durationMs: number | null;
  responseStatus: number | null;
  error: string | null;
}

function isInactive(endpoint: DeliveryContext["endpoint"]): boolean {
  return endpoint.status !== "active" || endpoint.deletedAt !== null;
}

// the host only, a full url can carry a path or a token that must not reach the logs
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

function skippedAttempt(): AttemptResult {
  return { outcome: "exhausted", startedAt: new Date(), durationMs: 0, responseStatus: null, error: "endpoint_inactive" };
}

// never throws: every failure of the request itself becomes a short code
async function sendRequest(job: DeliveryJob, client: DeliveryHttpClient): Promise<AttemptResult> {
  const startedAt = new Date();
  try {
    const { deliveryId, event, endpoint } = job.context;
    const body = buildBody(event);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = signPayload(deliveryId, timestampSeconds, body, endpoint.signingSecret);
    const response = await client.send({ url: endpoint.url, deliveryId, timestampSeconds, body, signature });
    const ok = response.status >= 200 && response.status < 300;
    return {
      outcome: ok ? "succeeded" : "exhausted",
      startedAt,
      durationMs: response.durationMs,
      responseStatus: response.status,
      error: ok ? null : `http_${response.status}`,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt.getTime();
    return { outcome: "exhausted", startedAt, durationMs, responseStatus: null, error: describeFailure(err) };
  }
}

function logResult(job: DeliveryJob, result: AttemptResult, recorded: "recorded" | "lease_lost"): void {
  const base = `delivery id=${job.claimed.id} host=${hostOf(job.context.endpoint.url)} attempt=${job.claimed.attemptCount}`;
  if (recorded === "lease_lost") {
    console.warn(`${base} outcome=lease_lost result dropped`);
    return;
  }
  const error = result.error ? ` error=${result.error}` : "";
  console.log(`${base} outcome=${result.outcome} status=${result.responseStatus ?? "none"} durationMs=${result.durationMs ?? 0}${error}`);
}

// one attempt, start to finish. it never throws, so a slot in the worker is always released.
// if the outcome cannot be written (database down) the row stays in_progress and the reaper
// picks it up once the lease runs out
export async function deliver(job: DeliveryJob, client: DeliveryHttpClient): Promise<void> {
  try {
    const result = isInactive(job.context.endpoint) ? skippedAttempt() : await sendRequest(job, client);
    const recorded = await recordOutcome({
      deliveryId: job.claimed.id,
      attemptNumber: job.claimed.attemptCount,
      ...result,
    });
    logResult(job, result, recorded);
  } catch (err) {
    console.error(`delivery id=${job.claimed.id} outcome not recorded, left to lease recovery: ${describeError(err)}`);
  }
}
