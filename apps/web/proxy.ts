import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "./lib/config";

// an early turn away for requests with no session cookie. it is only an extra layer: every
// protected page calls requireSession itself, and the api checks the key on every call
export function proxy(request: NextRequest) {
  if (request.cookies.has(appConfig.sessionCookieName)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/endpoints/:path*", "/deliveries/:path*"],
};
