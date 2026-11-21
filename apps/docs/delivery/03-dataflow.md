# Single-attempt delivery - dataflow

PostgreSQL `deliveries` -> Delivery worker -> Customer server, with the result written back to PostgreSQL.

## Success trace
Acme's delivery `0193f6b0-9a1c-7d02-b5e3-1c8f4a6d7e90` for endpoint A (`https://hooks.acme-billing.io/inbound`) is `pending`.

1. Worker 1 claims it: `in_progress`, `attempt_count` 1, lease until now + 60 s
2. It loads the 1.2 KB payload and the endpoint, which is active
3. It builds the body, sets `webhook-id` to the delivery id and `webhook-timestamp` to 1795238100, and signs `{id}.{timestamp}.{body}`
4. The lookup resolves the host to 52.4.118.20, which is public, and the connection is pinned to it
5. POST returns 200 in 142 ms
6. One transaction: the fenced update sets `succeeded` (1 row), and an attempt row `(1, 200, 142 ms)` is inserted

## Failure traces
- Customer returns 500: attempt row with 500, delivery `exhausted`. Feature 5 will schedule a retry here instead
- No answer for 10 s: the request is aborted, `exhausted` with `timeout`
- DNS points at `10.0.0.5`: the lookup rejects it, no socket opens, `exhausted` with `blocked_address`
- Worker 1 killed at t = 3 s mid-request: the row stays `in_progress`. After the lease expires at 60 s, a reaper records attempt 1 as `lease_expired` and sets the row back to `pending`. Worker 2 claims it as attempt 2 with the same `webhook-id`. If the customer had processed the first request, it sees a duplicate and dedupes
- Worker alive but slow: the lease expires mid-request and worker 2 takes over as attempt 2. When worker 1 finally finishes, its fenced update (`attempt_count = 1`) matches 0 rows, so its result is discarded
- Three lease expiries in a row: `exhausted`, so a delivery that keeps killing workers stops
- Endpoint disabled after fan-out: at claim no request is made and the delivery ends `exhausted` with `endpoint_inactive`
