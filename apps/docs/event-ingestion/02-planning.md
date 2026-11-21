# Event ingestion - planning

## Goal
Internal apps can publish events to Kafka through one authenticated endpoint, with a clear at-least-once guarantee and a smoke test that proves it.

## In scope
- Kafka in compose (KRaft, two listeners, topic init)
- `POST /v1/events`, ingest token auth, zod envelope schema in `packages/shared`
- A long-lived idempotent producer and a Kafka entry in `/health`
- A smoke script with a throwaway consumer

## Out of scope
- Consuming, matching and fan-out: feature 3
- Batch ingestion, per-producer credentials, schema registry, rate limiting: backlog
- Dedupe at the API: duplicates are absorbed in feature 3
- Production Kafka sizing (replication 3 and so on): documented, not built

## Build order
1. Compose: `kafka` and topic-init services, `KAFKA_PORT` env, broker healthy
2. Install the client library and check pnpm `allowBuilds` and the Docker image build
3. Shared envelope and request schemas
4. Producer module and shutdown hook
5. Ingest token middleware and `POST /v1/events`
6. Health: kafka check, shared health schema and the web health page updated
7. Smoke test
8. `pnpm verify` with the api container reaching `kafka:9093`

## Done when
- A 202 is returned only after the ack, and the message is on the topic with key `eventId` and the full envelope
- The same `eventId` posted twice gives two messages on the same partition, and both calls return 202
- A wrong or missing token returns 401, an invalid body 400, an oversized body 413
- Stopping the kafka container makes `POST /v1/events` return 503 within about 3 s, `/health` reports kafka down, and registration still works. Starting it again recovers without restarting the api
- `pnpm verify` passes with Kafka in the stack

## Risks
- The Confluent client under pnpm 11: its docs call pnpm support experimental, and it ships a prebuilt binary that must work in `node:24-slim`. Check this in step 2 before building on it
- An advertised listener mismatch makes clients connect and then hang. Verify from both the host and a container
- A producer that never recovers after a broker restart. The recovery test above covers it
