"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";
import type { LoginState } from "./types";

const INITIAL: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL);
  return (
    <form action={formAction} className="stack">
      <div className="field">
        <label htmlFor="apiKey">API key</label>
        <input id="apiKey" name="apiKey" type="password" autoComplete="off" required spellCheck={false} aria-describedby={state.error ? "login-error" : undefined} />
      </div>
      {state.error ? (
        <p id="login-error" role="alert" className="error">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "checking..." : "sign in"}
      </button>
    </form>
  );
}
