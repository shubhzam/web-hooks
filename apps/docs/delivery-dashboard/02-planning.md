# Delivery dashboard - planning

## Goal
A customer can run the whole webhook lifecycle from a browser: register an endpoint, watch deliveries, understand a failure from its attempt history, and replay it.

## In scope
- Three read endpoints and two indexes
- Login with an API key in an httpOnly cookie
- Endpoints page with create, enable or disable, delete
- Endpoint detail with stats and deliveries
- Delivery detail with attempts and replay

## Out of scope
- User accounts, sessions, key management screens
- Editing an endpoint's url or event types (delete and recreate)
- Event list and search, charts, rollup tables
- Live updates (polling, SSE)

## Build order
Backend first:
1. Shared schemas for list, detail, stats and the API error shape
2. Migration with the two indexes
3. Repository, services and routes
4. `smoke:dashboard-api`, the standalone backend test, then a stop for your review

Frontend:
5. `lib/api.ts`, session cookie, login and logout
6. `/endpoints` with its three actions
7. `/endpoints/[id]`
8. `/deliveries/[id]` with replay
9. Rebuild the web image, confirm `pnpm verify` still passes
10. Manual end-to-end checklist

## Done when
Backend:
- 120 seeded deliveries page in 3 requests with no duplicates, no gaps and newest first
- Filters narrow correctly, and another org's id gives 404 on detail and stats
- Stats counts and success rate match the seeded rows
- With 100,000 rows, EXPLAIN shows an index scan for the list and stats

Frontend:
- A bad key shows an error, a good key lands on `/endpoints`
- Create shows the secret once, and a refresh no longer shows it
- Toggle and delete work
- An exhausted delivery replays: it goes to pending and later succeeds, with attempt numbers continuing
- A revoked key mid-session returns you to `/login`
- The key never appears in page source, localStorage or browser-initiated requests

## Risks
- Next 16 details: async `cookies()`, redirects inside server actions
- The uuid lower bound must be tested against real ids around the boundary
- Large payloads in the browser: truncate server-side
