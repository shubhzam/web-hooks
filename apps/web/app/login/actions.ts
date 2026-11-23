"use server";

import { redirect } from "next/navigation";
import { checkApiKey } from "../../lib/api";
import { config } from "../../lib/config";
import { endSession, startSession } from "../../lib/session";
import type { LoginState } from "./types";

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

// a key that cannot be a header value is rejected here, without a call to the api
function readKey(formData: FormData): string | null {
  const raw = formData.get("apiKey");
  const key = typeof raw === "string" ? raw.trim() : "";
  return key.length > 0 && key.length <= config.apiKeyMaxLength && PRINTABLE_ASCII.test(key) ? key : null;
}

// the cookie is only set when the api accepts the key
export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const key = readKey(formData);
  if (key === null) return { error: "invalid api key" };
  const result = await checkApiKey(key);
  if (result === "unavailable") return { error: "the api is not reachable, try again in a moment" };
  if (result === "invalid") return { error: "invalid api key" };
  await startSession(key);
  redirect("/endpoints");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}
