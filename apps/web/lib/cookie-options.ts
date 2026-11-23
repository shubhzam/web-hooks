import type { Config } from "./config";

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  secure: boolean;
}

// httpOnly keeps the key away from browser scripts, lax keeps it off cross site posts
export function sessionCookieOptions(settings: Pick<Config, "sessionMaxAgeSeconds" | "sessionCookieSecure">): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: settings.sessionMaxAgeSeconds,
    secure: settings.sessionCookieSecure,
  };
}
