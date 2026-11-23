import { unstable_rethrow } from "next/navigation";
import type { EndpointStats } from "@repo/shared/delivery";
import { formatRate, formatUtc } from "../../../../lib/format";

// the stats call can be slow or fail, so this renders inside its own Suspense boundary and a
// failure only replaces this block. the promise is started by the page, in parallel with the rest
export async function Stats({ stats }: { stats: Promise<EndpointStats> }) {
  let value: EndpointStats;
  try {
    value = await stats;
  } catch (err) {
    // a rejected key or a missing endpoint is next's to handle, anything else is just "unavailable"
    unstable_rethrow(err);
    return (
      <p role="status" className="notice">
        stats unavailable
      </p>
    );
  }
  return (
    <section aria-labelledby="stats-heading">
      <h2 id="stats-heading">last 24 hours</h2>
      {value.pausedUntil ? (
        <p role="status" className="notice">
          deliveries to this endpoint are paused until {formatUtc(value.pausedUntil)} because it kept failing. they resume on their own.
        </p>
      ) : null}
      <dl className="stats">
        <Stat name="total" label="total" value={String(value.total)} />
        <Stat name="succeeded" label="delivered" value={String(value.succeeded)} />
        <Stat name="exhausted" label="failed" value={String(value.exhausted)} />
        <Stat name="pending" label="queued or retrying" value={String(value.pending)} />
        <Stat name="inProgress" label="sending" value={String(value.inProgress)} />
        <Stat name="successRate" label="success rate" value={formatRate(value.successRate)} />
      </dl>
      <p className="hint">success rate is delivered over delivered plus failed. deliveries still being retried are not counted yet.</p>
    </section>
  );
}

function Stat({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-stat={name}>{value}</dd>
    </div>
  );
}
