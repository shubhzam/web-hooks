type Env = Record<string, string | undefined>;

const SESSION_HOURS = 8;
const SECONDS_PER_HOUR = 3600;
const PAYLOAD_PREVIEW_KB = 50;
const BYTES_PER_KB = 1024;

// server side only, the browser never talks to the api directly
export class Config {
  readonly apiUrl: string;
  // the cookie is marked secure only when asked, compose serves plain http on localhost
  readonly sessionCookieSecure: boolean;

  // fixed settings, these are not read from the environment
  readonly sessionCookieName = "whk_session";
  readonly sessionMaxAgeSeconds = SESSION_HOURS * SECONDS_PER_HOUR;
  readonly deliveriesPageSize = 25;
  readonly endpointsPageSize = 50;
  readonly apiTimeoutMs = 5000;
  // counting a very busy endpoint can take seconds, so stats get longer than a normal call
  readonly statsTimeoutMs = 10000;
  readonly apiKeyMaxLength = 200;
  // the payload is cut here so a huge one cannot freeze the browser
  readonly payloadPreviewMaxBytes = PAYLOAD_PREVIEW_KB * BYTES_PER_KB;

  constructor(env: Env) {
    this.apiUrl = env["API_URL"] ?? "http://localhost:3001";
    this.sessionCookieSecure = env["SESSION_COOKIE_SECURE"] === "true";
  }
}

export const config = new Config(process.env);
