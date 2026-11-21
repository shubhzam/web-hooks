# Event ingestion - techspec

## Purpose
Accept events from our own internal applications and publish them durably to Kafka. This is the front of the data plane. Matching, fan-out and delivery are features 3 to 5, so nothing here reads Postgres or calls a customer.

## Event API
`POST /v1/events` with header `Authorization: Bearer <ingest token>`.

Body:
- `eventId`: uuid, required, supplied by the internal app so a retry reuses it
- `organizationId`: uuid, the tenant the event belongs to
- `type`: same format as registration event types, for example `invoice.paid`
- `occurredAt`: ISO 8601, optional, defaults to the receive time
- `payload`: JSON object, max 256 KB serialized

Response: 202 `{ "eventId", "status": "accepted" }`, returned only after the broker acknowledges the write. Errors use the shared error shape: 400 `validation_error`, 401 `unauthorized`, 413 `payload_too_large`, 503 `broker_unavailable` with `Retry-After: 1`.

## Auth
Internal apps share one static token from config (`INGEST_API_TOKEN`), compared with a timing-safe check. Customer API keys cannot post events. Per-producer credentials are later hardening. The API trusts the caller on `organizationId` and does not look it up in Postgres: an unknown organization simply matches no subscriptions in feature 3, and a lookup per event would put the database on the hottest path.

## Kafka
- Cluster: single-node KRaft in compose using the official `apache/kafka` image on a pinned 4.x tag, no ZooKeeper. Two listeners: HOST (`localhost:KAFKA_PORT`, for the api running on the host) and DOCKER (`kafka:9093`, for containers)
- Topic `webhook.events`: 6 partitions, replication factor 1 in dev (3 with `min.insync.replicas=2` in production), 7 day retention. Created by a one-shot compose init service with `--if-not-exists`; auto-create is off
- Client: `@confluentinc/kafka-javascript`, promisified KafkaJS-style API. KafkaJS has had no commits since August 2024, while this client wraps librdkafka and is maintained. `@platformatic/kafka` is pure TypeScript but its API is flagged experimental
- Producer: idempotent, `acks=-1` (all), one long-lived instance created at api boot and disconnected on shutdown, 3 s send timeout
- Key is `eventId`. Load spreads evenly across partitions, and a retried duplicate lands on the same partition as the original. There is no per-organization ordering guarantee and we do not promise one. Keying by organization would pin a busy tenant to one partition and slow its neighbors
- Value: JSON envelope `{ schemaVersion: 1, eventId, organizationId, type, occurredAt, receivedAt, payload }`. The zod schema lives in `packages/shared` so feature 3 validates at the consumer boundary

## Guarantee
At least once into Kafka. If the broker acknowledges but the response is lost, the internal app retries the same `eventId` and the topic can hold two copies. Feature 3 absorbs this with a unique `(event_id, endpoint_id)` constraint. We do not claim exactly once.

## Health
`/health` gains a `kafka` entry (producer connected and metadata fetched within 500 ms), reported but not required, like Redis. Registration keeps working when Kafka is down, while `POST /v1/events` fails fast with 503.

## Capacity target
500 events/s sustained, bursts to 2,000/s, about 1 KB each. That is 0.5 MB/s, or roughly 83 events/s per partition across 6. Feature 3 can run at most 6 consumers in parallel in one group.
