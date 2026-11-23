# Retries and exhaustion - planning

## Goal
Failed deliveries retry on a bounded schedule, a dead endpoint cannot tie up workers, and a customer can replay what exhausted, all without breaking feature 4's single-send guarantees.

## In scope
- Retry classification, backoff with jitter, `Retry-After`
- Attempt budget (8) shared with lease recovery, max age
- Redis-backed circuit breaker with a Postgres pause
- Replay endpoint
- Mock receiver routes for tests, smoke script, pure table check

## Out of scope
- Auto-disabling endpoints and notifying customers
- Delivery list and stats APIs, dashboard: feature 6
- Single-probe half-open state, per-endpoint rate limits
- Retention of old deliveries

## Build order
1. Migration and config (max attempts to 8, startup check on the delay list)
2. Pure logic: `decideRetry`, `nextDelay`, `parseRetryAfter`, position helper
3. HTTP client returns `Retry-After`
4. Repository: retry in the fenced write, position-based reaper cap, fenced release
5. Breaker module: Redis counters and the trip transaction
6. Wire `deliver`: age check, pause check, decision, breaker
7. Replay service and route
8. Mock receiver routes, `check:retry`, `smoke:retries`
9. Manual failure tests, then `pnpm verify`

## Done when
- A flaky endpoint (2 failures then 200) ends `succeeded` with 3 attempt rows spaced by the delays
- A 410 ends after 1 attempt. A 404 and a 500 each use all 8
- `Retry-After` is honored
- 25 deliveries to an always-failing endpoint trip the breaker: the receiver sees no more than threshold plus in-flight requests, the rest wait past `paused_until` with attempts unspent, and after healing all succeed
- A delivery 25 hours old ends `max_age_exceeded` with no request
- Replay works and attempt numbers continue (9, 10, ...). Another org's delivery is 404, a pending one 409
- With Redis stopped, deliveries still go out. Two workers never double-send

## Risks
- Worker clocks differ from Postgres, which matters for the `paused_until` check. Skew is small against a 5 minute pause, and the trip itself uses Postgres time
- The bulk deferral update on a huge backlog. Check its plan and duration with 100,000 rows
- Position math in three places (decision, reaper, replay). One shared helper, covered by the table check
