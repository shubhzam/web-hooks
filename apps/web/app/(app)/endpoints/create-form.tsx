"use client";

import { useActionState, useState } from "react";
import { createEndpointAction } from "./actions";
import type { CreateEndpointState, CreateFormValues } from "./types";

const INITIAL: CreateEndpointState = { status: "idle" };
const EMPTY: CreateFormValues = { url: "", eventTypes: "", description: "" };

function SecretPanel({ url, signingSecret }: { url: string; signingSecret: string }) {
  const [hidden, setHidden] = useState(false);
  const [copyNote, setCopyNote] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(signingSecret);
      setCopyNote("copied");
    } catch {
      setCopyNote("copy failed, select the text and copy it by hand");
    }
  }

  if (hidden) return null;
  return (
    <section aria-labelledby="secret-heading" className="notice">
      <h3 id="secret-heading">signing secret for {url}</h3>
      <p>this is the only time it is shown. it is gone when you close this panel or reload the page.</p>
      <p>
        <code className="secret">{signingSecret}</code>
      </p>
      <div className="row">
        <button type="button" onClick={copy}>
          copy secret
        </button>
        <button type="button" className="secondary" onClick={() => setHidden(true)}>
          i have saved it, close
        </button>
        <span role="status">{copyNote}</span>
      </div>
    </section>
  );
}

export function CreateEndpointForm() {
  const [state, formAction, pending] = useActionState(createEndpointAction, INITIAL);
  const values = state.status === "error" ? state.values : EMPTY;
  return (
    <section aria-labelledby="create-heading">
      <h2 id="create-heading">add an endpoint</h2>
      {state.status === "created" ? <SecretPanel key={state.id} url={state.url} signingSecret={state.signingSecret} /> : null}
      <form action={formAction} className="stack" key={state.status === "created" ? state.id : "form"}>
        <div className="field">
          <label htmlFor="url">URL (https)</label>
          <input id="url" name="url" type="url" required defaultValue={values.url} placeholder="https://example.com/webhooks" />
        </div>
        <div className="field">
          <label htmlFor="eventTypes">event types, one per line</label>
          <textarea id="eventTypes" name="eventTypes" rows={3} required defaultValue={values.eventTypes} placeholder={"invoice.paid\ninvoice.failed"} />
        </div>
        <div className="field">
          <label htmlFor="description">description (optional)</label>
          <input id="description" name="description" type="text" maxLength={200} defaultValue={values.description} />
        </div>
        {state.status === "error" ? (
          <ul role="alert" className="error">
            {state.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending ? "creating..." : "create endpoint"}
        </button>
      </form>
    </section>
  );
}
