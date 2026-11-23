"use client";

export default function ErrorPanel({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="narrow">
      <h1>this page could not load</h1>
      <p role="alert" className="error">
        the api may be unreachable or sent something unexpected. your session is still active.
      </p>
      <button type="button" onClick={() => retry()}>
        try again
      </button>
    </main>
  );
}
