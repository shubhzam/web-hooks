import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookieOptions } from "./cookie-options";
import { config } from "./config";

// the cookie value is the api key itself. there are no user accounts and no server side session
// table, so the cookie is the credential. httpOnly keeps it out of browser scripts, and only
// server code ever reads it

export async function readSessionKey(): Promise<string | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(config.sessionCookieName)?.value;
  return value === undefined || value === "" ? null : value;
}

// first line of every protected page. a proxy may also turn requests away, but it is only an
// extra layer, this is the check that counts
export async function requireSession(): Promise<string> {
  const key = await readSessionKey();
  if (key === null) redirect("/login");
  return key;
}

// server actions only, cookies cannot be written while a page renders
export async function startSession(key: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(config.sessionCookieName, key, sessionCookieOptions(config));
}

export async function endSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(config.sessionCookieName);
}
