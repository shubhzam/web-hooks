"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { ApiError, ApiUnavailableError, replayDelivery } from "../../../lib/api";
import type { ReplayState } from "./types";

function problemText(err: unknown): string {
  // the api words these two on purpose, delivery_not_replayable and endpoint_inactive
  if (err instanceof ApiError && err.status === 409 && err.apiMessage !== null) return err.apiMessage;
  if (err instanceof ApiUnavailableError) return "the api is not reachable, try again in a moment";
  return "the delivery could not be replayed";
}

export async function replayAction(_previous: ReplayState, formData: FormData): Promise<ReplayState> {
  const raw = formData.get("deliveryId");
  const deliveryId = typeof raw === "string" ? raw : "";
  try {
    await replayDelivery(deliveryId);
  } catch (err) {
    unstable_rethrow(err);
    return { status: "error", message: problemText(err) };
  }
  revalidatePath(`/deliveries/${deliveryId}`);
  return { status: "replayed" };
}
