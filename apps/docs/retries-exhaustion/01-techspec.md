# Retries and exhaustion - techspec

## Purpose
Replace feature 4's "any failure is terminal" with a retry policy, shield workers from dead endpoints, and let a customer replay what finally failed. Only the failure branch of the delivery worker changes.

## Classification
A pure function `decideRetry` maps an attempt result to one of three outcomes.
- 2xx: `succeeded`
- Terminal, never retried: `blocked_address`, `endpoint_inactive`, HTTP 410
- Retried: everything else (timeouts, network, DNS and TLS errors, 5xx, 429, 408, and every other 4xx or 3xx)

Retrying 4xx is deliberate. A 401 or 404 is usually a customer deploy bug fixed within hours, and losing events costs more than a few extra requests. The breaker below bounds the cost.

## Backoff and budget
Delays between attempts come from `DELIVERY_RETRY_DELAYS_MS`: 5 s, 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, each with plus or minus 20% jitter. `Retry-After` (seconds or HTTP date) on 429 and 503 raises the delay when larger, capped at 6 h. `DELIVERY_MAX_ATTEMPTS` is 8, so the last try lands about 9 hours after the first, and the 8th failure ends `exhausted`.

A delivery's position is `attempt_count - replay_base`. Position n failing uses delay n, and the reaper's cap uses the same position, so lease expiries and failures share one budget.

## Retry write
The same fenced transaction as feature 4. A retry sets `status = pending`, `next_attempt_at = now + delay` and clears the lease, then inserts the attempt row. Future-dated rows sit outside the claim query's `next_attempt_at <= now()` range, so the partial index stays cheap.

## Circuit breaker
- Redis counter `cb:<endpointId>:fails`: `INCR` on every endpoint-caused failure (not `blocked_address` or `endpoint_inactive`), TTL 1 h refreshed, `DEL` on success. Redis is volatile but uncontended, and losing it only delays tripping. If Redis is unreachable the breaker does nothing and delivery continues
- At 20 consecutive failures the worker runs `UPDATE webhook_endpoints SET paused_until = now() + 5 min WHERE id = $1 AND (paused_until IS NULL OR paused_until < now())`. Only the worker whose update matches a row continues: it moves the endpoint's pending deliveries to `paused_until` plus a random 0 to 150 s, so they do not stampede out together
- A delivery claimed for a paused endpoint (a new arrival) sends nothing. Its row is released to `pending` for after the pause and `attempt_count` is decremented, so no attempt is spent
- After the pause the endpoint is live again, and one more failure re-trips because the counter is still above 20

A dead endpoint therefore sees roughly `concurrency x workers` requests per 5 minute cycle.

## Max age
A delivery older than `DELIVERY_MAX_AGE_MS` (24 h) since `cycle_started_at` is exhausted without a request, error `max_age_exceeded`. Released deliveries spend no attempts, so this is what stops a dead endpoint holding rows forever.

## Replay
`POST /v1/deliveries/:id/replay` with a customer API key, org-scoped. Only an `exhausted` delivery on an active endpoint qualifies: 404 for another org's delivery, 409 `delivery_not_replayable`, 409 `endpoint_inactive`. One statement sets `status = pending`, `next_attempt_at = now`, `replay_base = attempt_count`, `cycle_started_at = now`, `completed_at = null`. Attempt history is kept and the delivery gets a fresh 8 attempts. Returns 202.

## Data model (migration)
`webhook_endpoints.paused_until`; `deliveries.replay_base` (int, default 0) and `deliveries.cycle_started_at` (default now).

## Config
`DELIVERY_RETRY_DELAYS_MS`, `DELIVERY_RETRY_JITTER` 0.2, `DELIVERY_RETRY_AFTER_MAX_MS` 21600000, `DELIVERY_MAX_ATTEMPTS` 8, `DELIVERY_MAX_AGE_MS` 86400000, `CIRCUIT_FAILURE_THRESHOLD` 20, `CIRCUIT_COOLDOWN_MS` 300000, `CIRCUIT_COUNTER_TTL_S` 3600, `CIRCUIT_RELEASE_SPREAD_MS` 150000. Startup fails if the delay list is shorter than `DELIVERY_MAX_ATTEMPTS - 1`.

## Guarantee
Unchanged: at least once, receivers dedupe on `webhook-id`. `exhausted` means we stopped trying, not that nothing arrived.
