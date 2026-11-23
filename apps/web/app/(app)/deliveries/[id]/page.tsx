import Link from "next/link";
import { DeliveryBadge } from "../../../_components/badges";
import { getDelivery } from "../../../../lib/api";
import { config } from "../../../../lib/config";
import { describeLastAttempt, formatUtc, isFuture, previewPayload } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { ReplayForm } from "./replay-form";

export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const delivery = await getDelivery(id);
  const preview = previewPayload(delivery.event.payload, config.payloadPreviewMaxBytes);
  const retryAt = delivery.status === "pending" && isFuture(delivery.nextAttemptAt, Date.now()) ? delivery.nextAttemptAt : null;
  return (
    <main>
      <p>
        <Link href={`/endpoints/${delivery.endpointId}`} prefetch={false}>
          back to the endpoint
        </Link>
      </p>
      <h1>delivery {delivery.id.slice(0, 8)}</h1>
      <dl className="facts">
        <div>
          <dt>status</dt>
          <dd>
            <DeliveryBadge status={delivery.status} attemptCount={delivery.attemptCount} />
            {retryAt ? <div className="hint">retry at {formatUtc(retryAt)}</div> : null}
          </dd>
        </div>
        <div>
          <dt>delivery id</dt>
          <dd>{delivery.id}</dd>
        </div>
        <div>
          <dt>event type</dt>
          <dd>{delivery.event.type}</dd>
        </div>
        <div>
          <dt>event id</dt>
          <dd>{delivery.event.id}</dd>
        </div>
        <div>
          <dt>event occurred</dt>
          <dd>{formatUtc(delivery.event.occurredAt)}</dd>
        </div>
        <div>
          <dt>delivery created</dt>
          <dd>{formatUtc(delivery.createdAt)}</dd>
        </div>
        <div>
          <dt>completed</dt>
          <dd>{delivery.completedAt ? formatUtc(delivery.completedAt) : "not yet"}</dd>
        </div>
        <div>
          <dt>last attempt</dt>
          <dd>{describeLastAttempt(delivery.lastAttempt)}</dd>
        </div>
      </dl>

      {delivery.status === "exhausted" ? (
        <section aria-labelledby="replay-heading">
          <h2 id="replay-heading">replay</h2>
          <ReplayForm deliveryId={delivery.id} />
        </section>
      ) : null}

      <section aria-labelledby="attempts-heading">
        <h2 id="attempts-heading">attempts</h2>
        {delivery.attempts.length === 0 ? (
          <p>no attempts yet.</p>
        ) : (
          <table>
            <caption>every attempt to deliver this event, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">attempt</th>
                <th scope="col">started</th>
                <th scope="col">duration</th>
                <th scope="col">result</th>
              </tr>
            </thead>
            <tbody>
              {delivery.attempts.map((attempt) => (
                <tr key={attempt.attemptNumber} data-attempt={attempt.attemptNumber}>
                  <td>{attempt.attemptNumber}</td>
                  <td>{formatUtc(attempt.startedAt)}</td>
                  <td>{attempt.durationMs === null ? "n/a" : `${attempt.durationMs} ms`}</td>
                  <td>{describeLastAttempt(attempt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="payload-heading">
        <h2 id="payload-heading">event payload</h2>
        {preview.truncated ? <p className="notice">the payload is longer than {config.payloadPreviewMaxBytes / 1024} KB, only the start is shown.</p> : null}
        <pre className="payload" tabIndex={0}>
          {preview.text}
        </pre>
      </section>
    </main>
  );
}
