# Single-attempt delivery - planning

## Goal
Every pending delivery gets one signed, SSRF-safe HTTP attempt, its outcome is recorded exactly once, and deliveries stranded by a dead worker are recovered without being lost or looping forever.

## In scope
- Migration: lease and completion columns, `delivery_attempts`, recovery index
- Signing (Standard Webhooks), address check, SSRF-safe HTTP client
- Claim, fenced outcome write, reaper
- Worker loop with bounded concurrency and a draining shutdown
- Mock receiver for tests, smoke script, SSRF table check

## Out of scope
- Retries, backoff, circuit breaking, auto-disable: feature 5
- Dashboard and delivery API for customers: feature 6
- Secret rotation, multiple signature versions, storing response bodies
- Per-endpoint rate limits, LISTEN/NOTIFY wake-ups
- Frontend: none

## Build order
1. Migration and `db:migrate:deploy`
2. Config additions and pure functions: body builder, signing, `isBlockedAddress`
3. HTTP client: undici `Agent` with a validating `lookup`, timeout, no redirects, body cap
4. Data module: claim, record outcome (fenced), reap
5. Worker loop, concurrency limit, shutdown drain
6. Compose: `delivery-worker`, plus `mock-receiver` under a `test` profile, with `DELIVERY_ALLOW_HOSTS=mock-receiver`
7. `smoke:delivery` and `check-ssrf`
8. Failure tests by hand, then `pnpm verify`

## Done when
- A delivery to the mock receiver succeeds, and the smoke script recomputes the signature independently and it matches
- A 500, a 10 s timeout and a redirect each end `exhausted` with the right error, and the redirect target gets no hit
- `169.254.169.254`, `localhost` and `10.0.0.5` end `blocked_address` with no connection attempted
- Two workers over 500 deliveries produce 500 attempt rows and no duplicate hits at the receiver
- `kill -9` on a worker mid-request: after lease expiry the delivery is re-sent once with the same `webhook-id` and ends `succeeded` with `attempt_count` 2
- A worker slower than its lease has its late result discarded
- SIGTERM drains in-flight deliveries and exits 0

## Risks
- undici's `lookup` callback shape (it may request all addresses at once). Test it against IPv4 and IPv6 targets
- Address-check gaps: IPv4-mapped IPv6, numeric hostnames. The table check must cover them
- A claim plan that stops using the partial index as the table grows. Check `EXPLAIN` on a seeded table
