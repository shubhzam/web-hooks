import Link from "next/link";
import { Suspense } from "react";
import { EndpointActions } from "../../../_components/endpoint-actions";
import { DeliveryBadge, EndpointBadge } from "../../../_components/badges";
import { getEndpoint, getEndpointStats, listDeliveries } from "../../../../lib/api";
import { readFilters } from "../../../../lib/filters";
import { describeLastAttempt, formatUtc, isFuture } from "../../../../lib/format";
import { buildQuery } from "../../../../lib/query";
import { requireSession } from "../../../../lib/session";
import { FILTER_OPTIONS } from "../../../../lib/status";
import { Stats } from "./stats";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EndpointPage({ params, searchParams }: PageProps) {
  await requireSession();
  const { id } = await params;
  const filters = readFilters(await searchParams);

  // stats start now so they run beside the other calls. the no-op catch only marks the promise as
  // handled in case the page stops early, the Stats block still sees the original rejection
  const stats = getEndpointStats(id);
  stats.catch(() => undefined);
  const [endpoint, page] = await Promise.all([getEndpoint(id), listDeliveries({ endpointId: id, ...filters })]);

  const base = `/endpoints/${id}`;
  const keep = { status: filters.status, eventType: filters.eventType };
  return (
    <main>
      <p>
        <Link href="/endpoints" prefetch={false}>
          all endpoints
        </Link>
      </p>
      <h1 className="wrap">{endpoint.url}</h1>
      <dl className="facts">
        <div>
          <dt>status</dt>
          <dd>
            <EndpointBadge status={endpoint.status} />
          </dd>
        </div>
        <div>
          <dt>event types</dt>
          <dd>{endpoint.eventTypes.join(", ")}</dd>
        </div>
        <div>
          <dt>description</dt>
          <dd>{endpoint.description ?? "none"}</dd>
        </div>
        <div>
          <dt>created</dt>
          <dd>{formatUtc(endpoint.createdAt)}</dd>
        </div>
      </dl>
      <EndpointActions id={endpoint.id} status={endpoint.status} />

      <Suspense
        fallback={
          <p role="status" className="hint">
            loading stats...
          </p>
        }
      >
        <Stats stats={stats} />
      </Suspense>

      <section aria-labelledby="deliveries-heading">
        <h2 id="deliveries-heading">deliveries</h2>
        <form method="get" action={base} className="filters">
          <div className="field">
            <label htmlFor="status">status</label>
            <select id="status" name="status" defaultValue={filters.status ?? ""}>
              <option value="">all</option>
              {FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="eventType">event type</label>
            <input id="eventType" name="eventType" type="text" defaultValue={filters.eventType ?? ""} placeholder="invoice.paid" />
          </div>
          <button type="submit">apply filters</button>
        </form>
        <p className="row">
          <Link href={`${base}${buildQuery({ ...keep, cursor: filters.cursor })}`} prefetch={false} data-link="refresh">
            refresh
          </Link>
          {filters.cursor ? (
            <Link href={`${base}${buildQuery(keep)}`} prefetch={false} data-link="newest">
              newest
            </Link>
          ) : null}
          {page.nextCursor ? (
            <Link href={`${base}${buildQuery({ ...keep, cursor: page.nextCursor })}`} prefetch={false} data-link="older">
              older
            </Link>
          ) : null}
        </p>
        {page.items.length === 0 ? (
          <p>no deliveries match.</p>
        ) : (
          <table>
            <caption>deliveries of this endpoint, newest first</caption>
            <thead>
              <tr>
                <th scope="col">delivery</th>
                <th scope="col">event type</th>
                <th scope="col">status</th>
                <th scope="col">attempts</th>
                <th scope="col">last attempt</th>
                <th scope="col">created</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.id} data-status={item.status}>
                  <td>
                    <Link href={`/deliveries/${item.id}`} prefetch={false}>
                      {item.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{item.eventType}</td>
                  <td>
                    <DeliveryBadge status={item.status} attemptCount={item.attemptCount} />
                    {item.status === "pending" && isFuture(item.nextAttemptAt, Date.now()) ? <div className="hint">retry at {formatUtc(item.nextAttemptAt)}</div> : null}
                  </td>
                  <td>{item.attemptCount}</td>
                  <td>{describeLastAttempt(item.lastAttempt)}</td>
                  <td>{formatUtc(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
