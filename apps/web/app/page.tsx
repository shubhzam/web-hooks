import Link from "next/link";
import { connection } from "next/server";
import { fetchHealth } from "../lib/health";

export default async function Home() {
  // health is read on every request, never frozen at build time
  await connection();
  const health = await fetchHealth();

  return (
    <main>
      <h1>web-hooks</h1>
      <p>
        <Link href="/endpoints" prefetch={false}>
          endpoints
        </Link>
      </p>
      {health === null ? (
        <p>api: unreachable</p>
      ) : (
        <>
          <p>{`api: ${health.status}`}</p>
          <ul>
            {Object.entries(health.dependencies).map(([name, dep]) => (
              <li key={name}>
                {name}: {dep.status} ({dep.latencyMs}ms{dep.required ? ", required" : ""})
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}