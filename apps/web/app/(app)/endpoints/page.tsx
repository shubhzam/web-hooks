import Link from "next/link";
import { EndpointActions } from "../../_components/endpoint-actions";
import { EndpointBadge } from "../../_components/badges";
import { listEndpoints } from "../../../lib/api";
import { readCursor } from "../../../lib/filters";
import { formatUtc } from "../../../lib/format";
import { buildQuery } from "../../../lib/query";
import { requireSession } from "../../../lib/session";
import { CreateEndpointForm } from "./create-form";

export default async function EndpointsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const cursor = readCursor(await searchParams);
  const page = await listEndpoints({ cursor });
  return (
    <main>
      <h1>endpoints</h1>
      <CreateEndpointForm />
      <section aria-labelledby="list-heading">
        <h2 id="list-heading">your endpoints</h2>
        {page.data.length === 0 ? (
          <p>no endpoints yet. add one above.</p>
        ) : (
          <table>
            <caption>webhook endpoints, in the order they were created</caption>
            <thead>
              <tr>
                <th scope="col">URL</th>
                <th scope="col">event types</th>
                <th scope="col">status</th>
                <th scope="col">created</th>
                <th scope="col">actions</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td className="wrap">
                    <Link href={`/endpoints/${endpoint.id}`} prefetch={false}>
                      {endpoint.url}
                    </Link>
                  </td>
                  <td>{endpoint.eventTypes.join(", ")}</td>
                  <td>
                    <EndpointBadge status={endpoint.status} />
                  </td>
                  <td>{formatUtc(endpoint.createdAt)}</td>
                  <td>
                    <EndpointActions id={endpoint.id} status={endpoint.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="row">
          {cursor ? (
            <Link href="/endpoints" prefetch={false}>
              first page
            </Link>
          ) : null}
          {page.nextCursor ? (
            <Link href={`/endpoints${buildQuery({ cursor: page.nextCursor })}`} prefetch={false}>
              more endpoints
            </Link>
          ) : null}
        </p>
      </section>
    </main>
  );
}
