# Delivery dashboard - dataflow

Browser -> Next.js server -> API -> PostgreSQL. The browser never talks to the API and never sees the key.

## Success trace
An Acme engineer fixes a broken endpoint and replays a failure.

1. They paste `whk_live_...` on `/login`. The server action calls the API with it, gets 200, and sets the httpOnly cookie
2. `/endpoints/<id>` renders. The server fetches stats and the delivery list in parallel: 24 h counts of 1,904 succeeded, 41 exhausted (95.9%) and the 50 newest deliveries
3. They filter to `exhausted` and open delivery `0193f6b0-9a1c-7d02-b5e3-1c8f4a6d7e90`. It shows 8 attempts, the last ending `http_503`
4. They press Replay. The server action posts to `/v1/deliveries/<id>/replay`, gets 202, and the page revalidates to `pending`
5. Seconds later a refresh shows attempt 9 with status 200 and the delivery `succeeded`

## Failure traces
- Wrong key at login: the API returns 401, the form shows "invalid key", no cookie is set
- Key revoked mid-session: the next page load gets 401, the cookie is cleared and the user lands on `/login`
- API down: the page renders an error panel with a retry link, and the cookie stays
- Replay races with another tab: the second press gets 409 `delivery_not_replayable`, shown inline, and a refresh shows the true state
- Endpoint disabled: replay returns 409 `endpoint_inactive`, and the message says to enable the endpoint first
- Another org's delivery id typed into the URL: the API returns 404 and the page shows not found, with no hint the id exists
- Secret panel closed or page refreshed: the secret is gone. The fix is delete and recreate until rotation exists
