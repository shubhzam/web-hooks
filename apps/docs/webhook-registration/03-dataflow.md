# Webhook registration - dataflow

Customer -> Registration API -> PostgreSQL. Later, the event processor reads these tables (feature 3). Nothing here calls the customer's server.

## Success trace
Acme's server sends `POST /v1/webhook-endpoints` with a Bearer key and the body `{"url": "https://hooks.acme-billing.io/inbound", "eventTypes": ["invoice.paid", "invoice.payment_failed"]}`.

1. The API hashes the key with SHA-256 and does one indexed lookup on `api_keys.key_hash`. It finds the Acme organization (`0193f5a2-7c1e-7b3a-9d4e-5a1f2c8b6e07`), not revoked. About 1 ms
2. Zod passes: https, public host, 2 event types
3. The API generates the endpoint id and the `whsec_` secret
4. One transaction writes 1 row to `webhook_endpoints` and 2 rows to `webhook_endpoint_event_types`, then commits
5. The API returns 201 with the endpoint and `signingSecret`

Three rows written, under 20 ms locally.

## Failure traces
- Revoked or unknown key: 401 at step 1, nothing written
- Same URL again for the same org: the insert violates the partial unique index, the transaction rolls back, 0 rows written, 409 `endpoint_url_exists`
- Postgres down at step 4: the transaction fails, nothing is committed, 500. Retrying is safe
- Response lost after commit: the endpoint exists but the client never saw the secret. A retry gets 409 and the secret cannot be fetched again, so the customer deletes and re-creates. Secret rotation closes this gap later
