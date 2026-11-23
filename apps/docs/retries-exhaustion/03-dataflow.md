# Retries and exhaustion - dataflow

PostgreSQL `deliveries` -> Delivery worker -> Customer server. Redis holds breaker counters only.

## Success trace (with one retry)
Acme's delivery `0193f6b0-9a1c-7d02-b5e3-1c8f4a6d7e90`, position 1.

1. 12:00:00 worker 1 claims it (`attempt_count` 1) and POSTs. The customer returns 503 with `Retry-After: 120`
2. `decideRetry` says retry. The jittered schedule gives about 5 s, `Retry-After` gives 120 s, the larger wins
3. The fenced transaction sets `pending`, `next_attempt_at` 12:02:00, and inserts attempt row `(1, 503, http_503)`. Redis `INCR` on the endpoint counter
4. 12:02:00 worker 2 claims it (`attempt_count` 2), same `webhook-id`, new timestamp. 200 in 138 ms
5. The delivery becomes `succeeded`, attempt row `(2, 200)`, Redis counter deleted

## Failure traces
- Eighth failure: position 8 fails, no delay is left, `exhausted`. About 9 hours after the first try
- HTTP 410: `exhausted` after attempt 1, no retry
- Endpoint down: the 20th consecutive failure trips the breaker. `paused_until` becomes now + 5 min and the endpoint's 340 pending deliveries move to `paused_until` plus 0 to 150 s. A delivery arriving mid-pause is claimed, released with `attempt_count` back to 0, and no request is made
- Redis down: the counter calls fail fast, the breaker does nothing, delivery continues normally
- Worker dies mid-request: feature 4's lease recovery, drawing from the same 8-attempt budget
- Delivery 25 hours old reaches a worker: `exhausted` with `max_age_exceeded`, no request
- Replay: `POST /v1/deliveries/<id>/replay` on an exhausted delivery with `attempt_count` 8 sets `replay_base` 8 and `pending`. The next attempt is number 9 and counts as position 1
