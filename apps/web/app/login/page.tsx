import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const expired = params["expired"] === "1";
  return (
    <main className="narrow">
      <h1>sign in</h1>
      <p>paste an api key to manage endpoints and see deliveries.</p>
      {expired ? (
        <p role="status" className="notice">
          the api did not accept your key, it may have been revoked. sign in again.
        </p>
      ) : null}
      <LoginForm />
    </main>
  );
}
