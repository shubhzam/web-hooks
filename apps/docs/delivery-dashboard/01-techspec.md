# Delivery dashboard - techspec

## Purpose
A customer opens the web app, pastes an API key, manages endpoints, sees what happened to each delivery and replays failures. The backend adds three read endpoints. Feature 1's endpoint CRUD and feature 5's replay are reused as they are.

## Backend additions (customer API key, org-scoped, other orgs get 404)
- `GET /v1/deliveries`: newest first. Filters `endpointId`, `status`, `eventType`. `limit` (default 50, max 100) and `cursor` (last id). Each item: `id`, `eventId`, `eventType`, `endpointId`, `status`, `attemptCount`, `nextAttemptAt`, `createdAt`, `completedAt`, and `lastAttempt` (`responseStatus`, `error`) or null
- `GET /v1/deliveries/:id`: the same fields plus `event` (`type`, `occurredAt`, `payload`) and `attempts` ordered by number (`attemptNumber`, `startedAt`, `durationMs`, `responseStatus`, `error`)
- `GET /v1/webhook-endpoints/:id/stats`: last 24 hours. Counts by status, `successRate` (succeeded over succeeded plus exhausted, null when nothing finished) and `pausedUntil` (null unless in the future). Feature 1's responses stay unchanged

Delivery ids are uuidv7, so id order is creation order. The list is `id < cursor ORDER BY id DESC`, served by two new indexes, `(organization_id, id)` and `(endpoint_id, id)`, scanned backwards. They add write cost to our hottest table, which is acceptable at 1,500 inserts/s. The stats window uses the same property: a uuid built from `now - 24h` (timestamp in the top 48 bits) is a lower bound on `id`, so no `created_at` index is needed. A very hot endpoint (17M rows a day at 200/s) still takes seconds to count, so the UI loads stats separately. Rollup tables are backlog.

## Web app
Next.js server components and server actions, no new dependencies, plain CSS on the existing variables. `/` stays the health page that `pnpm verify` greps, with one link added. Routes: `/login`, `/endpoints`, `/endpoints/[id]`, `/deliveries/[id]`.

## Session
Login is a server action that calls `GET /v1/webhook-endpoints?limit=1` with the pasted key. On 200 the key goes into cookie `whk_session`: httpOnly, SameSite=Lax, 8 hours, `Secure` when `SESSION_COOKIE_SECURE=true` (off by default because compose serves plain http on localhost). Only server code reads it, so the key never reaches browser JavaScript. Any 401 clears the cookie and redirects to `/login`. The trade-off is that the cookie is the credential. A real product would use user accounts and sessions, and keep API keys for machines.

Every API call goes through `lib/api.ts`: it reads the cookie, adds the bearer header, parses the response with the shared zod schemas and turns the error shape into typed errors. Server actions carry Next's origin check, which together with SameSite gives us CSRF protection.

## Pages
- `/endpoints`: table, create form (url, event types one per line, description), enable or disable, delete with confirmation. A created endpoint's `signingSecret` comes back from the action and appears once in a copy panel. It is never in a URL, cookie or log, and a refresh loses it by design
- `/endpoints/[id]`: stats, a paused banner with the resume time, and the delivery list with a status filter and an "older" link using the cursor
- `/deliveries/[id]`: event type, payload as pretty JSON (truncated past 50 KB with a note), the attempts table, and a Replay button only when the status is `exhausted`. A 409 shows inline. A `pending` delivery with a future `nextAttemptAt` shows "retry at <time>"

## Not live
Pages render per request. A Refresh link reloads them. Polling and SSE are backlog.

## Errors
API unreachable: a page-level error panel with a retry link, not a crash. Unknown or foreign ids: the not-found page.
