# Event ingestion - dataflow

Internal app -> Event API -> Kafka topic. Feature 3's processor reads the topic later. Nothing here touches Postgres or calls a customer.

## Success trace
The billing service posts an `invoice.paid` event for Acme. `eventId` is `0193f6b0-4e2a-7c91-8b3d-6f4a9d1c2e58`, payload 1.2 KB.

1. The bearer token matches `INGEST_API_TOKEN` (timing-safe)
2. Zod passes, and the API builds the envelope with `receivedAt`
3. The Kafka producer sends to `webhook.events` with key `eventId`, which hashes to partition 4 of 6 (example)
4. The leader appends the message, acks with `acks=all`, and returns offset 18,442
5. The API returns 202, about 5 to 15 ms locally

The event is durable in Kafka before the internal app hears 202. Save downstream first, ack upstream second.

## Failure traces
- Wrong token: 401, nothing sent
- Invalid body or over 256 KB: 400 or 413, nothing sent
- Broker down: the send times out after 3 s, the API returns 503 with `Retry-After: 1`, nothing is on the topic, and the internal app retries later
- Ack lost: Kafka has the message (offset 18,442) but the API times out and returns 503. The internal app retries the same `eventId` and gets 202, leaving a second copy on partition 4 (offset 18,447). Feature 3 absorbs the duplicate
- API crashes after the ack but before the response: same as ack lost
