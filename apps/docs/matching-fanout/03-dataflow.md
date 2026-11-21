# Matching and fan-out - dataflow

Kafka topic -> Event processor -> PostgreSQL (`events`, `deliveries`). Delivery workers read `deliveries` later (feature 4).

## Success trace
One processor holds all 6 partitions. A batch arrives from partition 4: 60 messages, offsets 18,442 to 18,501. The first is the Acme `invoice.paid` event, `eventId` 0193f6b0-4e2a-7c91-8b3d-6f4a9d1c2e58. Acme has three endpoints: A (`invoice.paid`, `invoice.payment_failed`), B (`invoice.paid`) and C (`customer.created`), all active and registered long before.

1. All 60 messages pass envelope validation
2. One transaction opens. 60 rows go into `events`
3. The processor loads endpoints for the 14 distinct `(organization, type)` pairs in the batch. For Acme `invoice.paid`: A and B match, C does not
4. 171 rows go into `deliveries` in one chunk. Two of them are Acme's, for A and B, both `pending` with `next_attempt_at` now
5. The transaction commits, then offset 18,502 is committed for partition 4

About 40 ms for the batch. Log line: `batch partition=4 offsets=18442-18501 events=60 deliveries=171 durationMs=41`.

## Failure traces
- Postgres down at step 2: the transaction fails, nothing is committed and the offset stays at 18,442. The processor retries after 1 s, 2 s, 4 s and so on, up to 30 s. Lag grows while Kafka holds the data, and when Postgres returns the same batch lands once
- Crash after the commit but before the offset commit: on restart the consumer resumes at 18,442 and reads the batch again. Both `ON CONFLICT` clauses skip every row, 0 new deliveries, then the offset commits
- Duplicate from feature 2 (same `eventId` at offset 18,447): the second insert is skipped, still 2 deliveries for Acme
- Poison message at offset 18,450 (not valid JSON): copied to `webhook.events.dlq` with its error and source offset, then the other 59 messages continue
- Endpoint B set to `disabled` one second before processing: only A gets a delivery. An endpoint D created after `received_at` gets none, even on replay
