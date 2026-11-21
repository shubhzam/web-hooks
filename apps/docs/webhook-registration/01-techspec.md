# Webhook registration - techspec

## Purpose
Let a customer (an organization) register HTTPS endpoints and choose which event types each one receives. This is the control plane only. Nothing is delivered in this feature.

## Data model (PostgreSQL via Prisma)
- `organizations`: `id` (uuidv7), `name`, `created_at`
- `api_keys`: `id`, `organization_id`, `key_prefix` (first 8 chars of the random part, for display), `key_hash` (SHA-256 hex, unique), `revoked_at`, `created_at`
- `webhook_endpoints`: `id`, `organization_id`, `url`, `description`, `signing_secret`, `status` (`active` or `disabled`), `deleted_at`, `created_at`, `updated_at`. Partial unique index on `(organization_id, url)` where `deleted_at` is null
- `webhook_endpoint_event_types`: `endpoint_id`, `event_type`. Primary key `(endpoint_id, event_type)`, plus an index on `event_type` for feature 3 matching

## API (all under /v1, header `Authorization: Bearer whk_live_...`)
| Method and path | Result |
| --- | --- |
| POST /v1/webhook-endpoints | 201, includes `signingSecret` (the only time it is shown) |
| GET /v1/webhook-endpoints | 200, `limit` (default 50, max 100) and `cursor` (last id; uuidv7 order is creation order) |
| GET /v1/webhook-endpoints/:id | 200 |
| PATCH /v1/webhook-endpoints/:id | 200, accepts `url`, `eventTypes`, `description`, `status` |
| DELETE /v1/webhook-endpoints/:id | 204, soft delete |

## Auth
Keys are `whk_live_` plus 32 random bytes in base64url. Only the SHA-256 hash is stored: a random 256-bit key does not need a slow hash, and hashing lets us find the key with one indexed lookup. The full key is shown once, at creation. Missing, unknown and revoked keys all return the same 401. Every query is scoped by `organization_id`, and another org's endpoint returns 404, never 403, so existence does not leak.

Bootstrapping: there is no signup endpoint. An admin script (`pnpm --filter api create-org <name>`) creates an organization and its first key and prints the key once.

## Validation (zod at the boundary, schemas in packages/shared)
- `url`: https only, max 2048 chars, no userinfo, no `localhost`, no literal private, loopback or link-local IPs. This is early feedback, not security: DNS can change after registration, so the real SSRF check happens at delivery time (feature 4)
- `eventTypes`: 1 to 20 items, each matching `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` (for example `invoice.paid`). Exact match only, no wildcards, no catalog yet
- `description`: optional, max 200 chars

## Signing secret
Generated server side as `whsec_` plus 32 random bytes in base64. Stored in plaintext in this feature because HMAC signing needs the raw value at delivery time. Encryption at rest is later hardening. The signature format is decided in feature 4.

## Errors
One shape: `{ "error": { "code", "message", "details?" } }`. Codes: `validation_error` (400), `unauthorized` (401), `not_found` (404), `endpoint_url_exists` (409), `internal_error` (500).

## Writes
Create and update touch the endpoint row and its event-type rows in one Prisma transaction. A Postgres unique violation (`23505`) on the URL index maps to 409.
