# Webhook registration - planning

## Goal
A customer can register, inspect, change and remove webhook endpoints with their API key, and the data is shaped so feature 3 (matching and fan-out) can read it directly.

## In scope
- The four tables and the first migration
- Five endpoints, API key auth, zod validation, the error shape
- An admin script that creates an organization and its first key
- One web page: paste an API key, create an endpoint, list and delete

## Out of scope
- Event ingestion and Kafka: feature 2
- Matching, delivery and retries: features 3 to 5
- Secret rotation, API key management endpoints, an event type catalog, wildcards: backlog
- Rate limiting, idempotency keys, endpoint ownership verification: backlog
- SSRF enforcement at connect time: feature 4

## Build order
1. Prisma models and migration (`migrate dev`, `generate`, `tsc --noEmit`). The partial unique index is hand-edited SQL in the migration, because Prisma cannot declare it
2. Shared zod schemas in `packages/shared`
3. Services layer: `api-keys` and `webhook-endpoints`, with thin route handlers
4. Auth middleware and the error handler
5. Routes and the admin script
6. Standalone backend test with curl against the running api
7. Web page
8. End to end through compose: `pnpm verify` plus one registration

## Done when
- Create returns 201 with a secret, and list never contains secrets
- The same URL twice returns 409, another org's id returns 404, a bad key returns 401
- Deleting an endpoint and re-creating the same URL works
- Postgres rows match the responses and `pnpm verify` still passes

## Risks
- The hand-edited partial index can drift from `schema.prisma`, so leave a comment in the schema next to the model
- Plaintext signing secrets are accepted for now and tracked for later hardening
