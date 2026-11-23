"use client";

import { useActionState } from "react";
import { replayAction } from "../actions";
import type { ReplayState } from "../types";

const INITIAL: ReplayState = { status: "idle" };

export function ReplayForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction, pending] = useActionState(replayAction, INITIAL);
  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <p>this delivery used all its attempts. replaying starts a fresh set of attempts, and attempt numbers carry on.</p>
      <div>
        <button type="submit" disabled={pending}>
          {pending ? "replaying..." : "replay"}
        </button>
      </div>
      {state.status === "error" ? (
        <p role="alert" className="error">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
