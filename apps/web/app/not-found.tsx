import Link from "next/link";

export default function NotFound() {
  return (
    <main className="narrow">
      <h1>not found</h1>
      <p>there is nothing here.</p>
      <p>
        <Link href="/endpoints" prefetch={false}>
          back to endpoints
        </Link>
      </p>
    </main>
  );
}
