# Single-attempt delivery with lease recovery - techspec

## Purpose
Turn `pending` deliveries into signed HTTPS POSTs to customer endpoints, one attempt each, and recover work stranded by crashed workers. Retries and backoff are feature 5, so here a definite failure is terminal.

## Process
A third entrypoint in `apps/api`, `src/delivery-worker.ts`, its own compose service on the same image, with no HTTP server. Copies can run side by side.

## Claim
One statement moves rows from `pending` to `in_progress`: select ready rows (`status = pending`, `next_attempt_at <= now()`, ordered by `next_attempt_at`) with `FOR UPDATE SKIP LOCKED`, set `attempt_count = attempt_count + 1` and `lease_expires_at = now() + 60 s`, and return them. Workers never block each other or claim the same row. The worker then loads the event payload and the endpoint (url, secret, status, `deleted_at`). If the endpoint is no longer active, no request is made and the delivery becomes `exhausted` with error `endpoint_inactive`. It polls every 500 ms when idle.

## Request
POST to the endpoint URL with a JSON body `{ eventId, type, occurredAt, data }` serialized once. Headers follow the Standard Webhooks scheme:
- `webhook-id`: the delivery id, identical on every attempt, so receivers can dedupe
- `webhook-timestamp`: unix seconds, set per attempt
- `webhook-signature`: `v1,` plus base64 HMAC-SHA256 over `{id}.{timestamp}.{body}`. The key is the base64-decoded part of the secret after `whsec_`, which is exactly how feature 1 generates it

## Outcome
2xx is `succeeded`. Anything else (non-2xx including 3xx, timeout, network error, blocked address) is `exhausted` with a short error code. Timeout 10 s, no redirects, response body capped at 64 KB and discarded. The result is written in one transaction: first a fenced update `WHERE id = $1 AND status = 'in_progress' AND attempt_count = $claimed`, then an insert into `delivery_attempts`. If the update touches 0 rows, the lease was lost to another worker, the transaction rolls back and the result is dropped.

## SSRF guard (delivery time)
We check the resolved address with a custom `lookup` on an undici `Agent` (`connect.lookup`), so the checked address is the one the socket connects to and DNS cannot change in between. We use undici's own client with that dispatcher, because its `fetch` ignores Node's `http.Agent`. Blocked: loopback, private ranges, 169.254/16 (cloud metadata), 100.64/10, 0.0.0.0/8, multicast and reserved ranges, their IPv6 equivalents and IPv4-mapped forms. https only. `DELIVERY_ALLOW_HOSTS` (empty by default, dev and test only) lists exact hostnames that may use http and skip the address check.

## Lease recovery
Every worker runs a reaper every 15 s over rows with `status = in_progress` and `lease_expires_at < now()` (`SKIP LOCKED`). It records the lost attempt as `lease_expired`, then returns the row to `pending` if `attempt_count < DELIVERY_MAX_ATTEMPTS` (3), else marks it `exhausted`. A lost attempt's outcome is unknown, so we resend with the same `webhook-id` rather than drop. The cap stops a delivery that keeps killing workers.

## Data model (migration)
`deliveries` gains `lease_expires_at` and `completed_at`, plus a partial index on `lease_expires_at` where `status = in_progress`. New `delivery_attempts`: `id` (uuidv7), `delivery_id`, `attempt_number`, `started_at`, `duration_ms`, `response_status`, `error`, unique `(delivery_id, attempt_number)`.

## Guarantee
At least once to the customer's server. Duplicates happen when a worker dies after the customer replied but before we recorded it, or loses its lease. Receivers dedupe on `webhook-id`. Not exactly once.

## Config
`DELIVERY_CONCURRENCY` 50, `DELIVERY_TIMEOUT_MS` 10000, `DELIVERY_LEASE_MS` 60000, `DELIVERY_MAX_ATTEMPTS` 3, `DELIVERY_REAPER_INTERVAL_MS` 15000, `DELIVERY_POLL_INTERVAL_MS` 500, `DELIVERY_ALLOW_HOSTS` (empty).

## Capacity
Concurrency equals rate times latency. At 250 ms average customer latency, one worker with 50 slots sustains about 200 deliveries/s, so feature 3's 1,500/s needs about 8 workers. No per-endpoint isolation yet: a hanging endpoint holds slots for up to 10 s each. Circuit breaking comes in feature 5.
