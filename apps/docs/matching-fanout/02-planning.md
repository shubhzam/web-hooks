# Matching and fan-out - planning

## Goal
Every accepted event produces exactly one pending delivery per matching endpoint in Postgres, survives crashes, replays and duplicates, and bad messages never block the stream.

## In scope
- Prisma models and migration for `events` and `deliveries`
- Processor process, compose service and DLQ topic
- Batch consumer, matching query, chunked inserts, manual offset commits
- Graceful shutdown: finish the in-flight batch, commit, disconnect
- A smoke script plus the failure tests below

## Out of scope
- HTTP delivery, signing, leases, retries and exhaustion: features 4 and 5
- Wildcard event types, endpoint caching in Redis, per-org endpoint caps
- Retention and table partitioning for `events` and `deliveries`
- Frontend: none for this feature

## Build order
1. Prisma models, migration, hand-edited partial index, `db:migrate:deploy`
2. kafka-init creates the DLQ topic (1 partition, 30 day retention)
3. Consumer module: group join, batching, manual commit
4. Fan-out service: parse, match, transactional insert. Matching and chunking as small pure functions
5. Processor entrypoint, retry with backoff, shutdown hook
6. DLQ publish path
7. Compose `processor` service on the api image
8. `smoke:fanout` script
9. Failure tests, then `pnpm verify` with the processor running

## Done when
- An event for an org with 3 endpoints (2 matching, 1 not) produces 1 `events` row and 2 `pending` deliveries
- The same `eventId` ingested twice still leaves 1 event and 2 deliveries
- Disabled, soft-deleted and later-created endpoints get no delivery
- Postgres stopped mid-stream: nothing lost, offsets do not move, and after Postgres returns every event appears exactly once
- Offsets reset to earliest with the processor stopped: after the replay the row counts are unchanged
- A garbage message lands in the DLQ and the next valid events still process
- Two processors in the group during a rebalance produce no duplicate rows and no lost events

## Risks
- Offset semantics of the Confluent client's batch API. Check what commits when, in the library docs, before building on it
- A rebalance during a slow batch can replay it. The constraints make this safe, but watch the logs
- One hot org with hundreds of endpoints makes oversized batches. The chunking covers it, and the test should include one such org
