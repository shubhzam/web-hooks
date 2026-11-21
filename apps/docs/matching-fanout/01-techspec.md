# Matching and fan-out - techspec

## Purpose
Read events from Kafka, find the endpoints that should receive each one, and write one delivery job per match into PostgreSQL. No HTTP call to a customer happens here (feature 4).

## Process
A separate long-running process, `apps/api/src/processor.ts`, built into the same image as the api and started with `node dist/processor.js` as its own compose service. It reuses the config class, Prisma client, Kafka client and shared schemas, and has no HTTP server. If the coupling hurts when the delivery worker arrives, we extract a package then.

## Consumer
- Group `event-processor` on `webhook.events`, auto-commit off, offsets committed by hand
- Batches of up to 100 messages or 200 ms, whichever comes first
- At most 6 consumers can work in parallel (one per partition). We run 1 and scale in the failure tests

## Data model (new migration)
- `events`: `event_id` uuid primary key, `organization_id`, `type`, `payload` jsonb, `occurred_at`, `received_at`, `created_at`. The payload is stored once, not copied into every delivery
- `deliveries`: `id` (uuidv7), `event_id`, `endpoint_id`, `organization_id`, `status` enum (`pending`, `in_progress`, `succeeded`, `exhausted`), `attempt_count` default 0, `next_attempt_at` default now, `created_at`. Unique `(event_id, endpoint_id)`. Partial index on `next_attempt_at` where status is `pending`, added by hand-edited migration SQL. Lease and error columns arrive with features 4 and 5

## Matching rule
An endpoint matches an event when all of these hold:
- same `organization_id`
- `status = active` and `deleted_at` is null
- `created_at <= event.received_at`
- an event-type row equals the event `type` exactly

Status, deletion and event types are read at processing time. The `created_at` filter makes replay deterministic: an endpoint registered after the event arrived never receives it, even if the event is processed again later.

## Batch transaction
1. Parse each message and validate it with the shared envelope schema. Invalid ones go to the DLQ (below)
2. One Postgres transaction: insert `events` with `ON CONFLICT DO NOTHING`, load matching endpoints once per distinct `(organization_id, type)` pair, insert `deliveries` in chunks of 1,000 rows with `ON CONFLICT (event_id, endpoint_id) DO NOTHING`
3. After the commit, commit the offsets (highest offset + 1 per partition)

Save downstream first, ack upstream second.

## Failure handling
- Transient (database down, timeout, deadlock): commit nothing, retry the same batch with backoff from 1 s doubling to 30 s
- Poison (bad JSON, envelope fails validation): publish the original bytes to `webhook.events.dlq` with headers carrying the error, source partition and offset, then treat it as handled. If the DLQ publish fails, treat that as transient
- Duplicates (feature 2 retries, rebalance replays): absorbed by the two `ON CONFLICT` clauses

## Guarantee
At least once from Kafka into Postgres, and effectively once per `(event, endpoint)` inside Postgres. Not exactly once delivery to customers.

## Config additions
`KAFKA_CONSUMER_GROUP` (default `event-processor`), `KAFKA_DLQ_TOPIC` (default `webhook.events.dlq`), `PROCESSOR_BATCH_SIZE` (100), `PROCESSOR_BATCH_WAIT_MS` (200), `PROCESSOR_RETRY_MAX_MS` (30000).

## Capacity
At 500 events/s and an average fan-out of 3, that is about 1,500 delivery rows/s, or 5 batches/s of roughly 300 rows each. The worst case is an org with 200 endpoints on one type: 100 events become 20,000 rows, hence the chunked inserts. Sustained, `events` grows about 43 GB a day at 1 KB per event and `deliveries` about 130M rows a day, so retention is required before real load. It is on the backlog, not in this feature.
