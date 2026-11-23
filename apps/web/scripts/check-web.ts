import { Config } from "../lib/config";
import { sessionCookieOptions } from "../lib/cookie-options";
import { readFilters } from "../lib/filters";
import { describeLastAttempt, formatRate, formatUtc, isFuture, previewPayload } from "../lib/format";
import { buildQuery } from "../lib/query";
import { FILTER_OPTIONS, endpointStatusLabel, statusLabel, statusTone } from "../lib/status";

// usage: pnpm check:web (no stack needed)
// table checks of the pure helpers of the dashboard: status labels, cookie options, links,
// time formatting and the payload preview

class CheckFailure extends Error {}

// prints one line and stops on the first failed check
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) {
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    throw new CheckFailure(name);
  }
  console.log(`ok   ${name}`);
}

const VALID_ID = "0193f6b0-9a1c-7d02-b5e3-1c8f4a6d7e90";

function checkStatus(): void {
  check("exhausted is failed", statusLabel("exhausted", 8) === "failed");
  check("exhausted is failed with no attempts too", statusLabel("exhausted", 0) === "failed");
  check("pending with 0 attempts is queued", statusLabel("pending", 0) === "queued");
  check("pending with 1 attempt is retrying", statusLabel("pending", 1) === "retrying");
  check("pending with 7 attempts is retrying", statusLabel("pending", 7) === "retrying");
  check("in_progress is sending", statusLabel("in_progress", 1) === "sending");
  check("in_progress with 0 attempts is sending", statusLabel("in_progress", 0) === "sending");
  check("succeeded is delivered", statusLabel("succeeded", 1) === "delivered");
  check("succeeded after a replay is delivered", statusLabel("succeeded", 9) === "delivered");
  check("tones follow the outcome", statusTone("succeeded") === "good" && statusTone("exhausted") === "bad" && statusTone("pending") === "wait" && statusTone("in_progress") === "active");
  check("the filter offers every status once", FILTER_OPTIONS.map((o) => o.value).sort().join() === "exhausted,in_progress,pending,succeeded");
  check("the filter labels match the badges", FILTER_OPTIONS.find((o) => o.value === "exhausted")?.label === "failed" && FILTER_OPTIONS.find((o) => o.value === "succeeded")?.label === "delivered");
  check("an active endpoint reads enabled", endpointStatusLabel("active") === "enabled" && endpointStatusLabel("disabled") === "disabled");
}

function checkCookie(): void {
  const plain = sessionCookieOptions(new Config({}));
  check("the cookie is httpOnly, lax, on every path", plain.httpOnly && plain.sameSite === "lax" && plain.path === "/");
  check("the cookie lasts 8 hours", plain.maxAge === 8 * 3600);
  check("the secure flag is off by default", plain.secure === false);
  check("the secure flag follows SESSION_COOKIE_SECURE=true", sessionCookieOptions(new Config({ SESSION_COOKIE_SECURE: "true" })).secure === true);
  check("any other value keeps it off", sessionCookieOptions(new Config({ SESSION_COOKIE_SECURE: "false" })).secure === false && sessionCookieOptions(new Config({ SESSION_COOKIE_SECURE: "1" })).secure === false);
  check("the cookie is called whk_session", new Config({}).sessionCookieName === "whk_session");
  check("the page size is 25", new Config({}).deliveriesPageSize === 25);
  check("the api url defaults to localhost and can be set", new Config({}).apiUrl === "http://localhost:3001" && new Config({ API_URL: "http://api:3001" }).apiUrl === "http://api:3001");
}

function checkQuery(): void {
  check("no params is an empty string", buildQuery({}) === "");
  check("an empty cursor is dropped", buildQuery({ status: "exhausted", cursor: "" }) === "?status=exhausted");
  check("an undefined cursor is dropped", buildQuery({ status: "exhausted", cursor: undefined }) === "?status=exhausted");
  check("a null value is dropped", buildQuery({ status: null, eventType: "a.b" }) === "?eventType=a.b");
  check("filters and a cursor are kept", buildQuery({ status: "exhausted", eventType: "invoice.paid", cursor: VALID_ID }) === `?status=exhausted&eventType=invoice.paid&cursor=${VALID_ID}`);
  check("only empty values give an empty string", buildQuery({ status: "", cursor: undefined }) === "");
  check("values are encoded", buildQuery({ eventType: "a b&c" }) === "?eventType=a+b%26c");
}

function checkFilters(): void {
  const good = readFilters({ status: "exhausted", eventType: "invoice.paid", cursor: VALID_ID });
  check("good params are read", good.status === "exhausted" && good.eventType === "invoice.paid" && good.cursor === VALID_ID);
  const bad = readFilters({ status: "failed", eventType: "Not A Type", cursor: "abc" });
  check("bad params are dropped, not errors", bad.status === undefined && bad.eventType === undefined && bad.cursor === undefined);
  const empty = readFilters({ status: "", eventType: "", cursor: "" });
  check("empty params are dropped", empty.status === undefined && empty.eventType === undefined && empty.cursor === undefined);
  check("a repeated param uses the first value", readFilters({ status: ["pending", "succeeded"] }).status === "pending");
  check("missing params are undefined", readFilters({}).status === undefined);
}

function checkFormat(): void {
  check("a utc time ends with UTC", formatUtc("2026-11-23T01:38:56.608Z") === "2026-11-23 01:38:56 UTC");
  check("an offset time is shown in utc", formatUtc("2026-11-23T03:38:56+02:00") === "2026-11-23 01:38:56 UTC");
  check("a bad time is flagged", formatUtc("not a time") === "invalid date");
  check("a rate shows one decimal", formatRate(0.95918) === "95.9%" && formatRate(1) === "100.0%" && formatRate(0) === "0.0%");
  check("no finished deliveries reads n/a", formatRate(null) === "n/a");
  check("a future time is in the future", isFuture("2026-11-23T01:00:01Z", Date.parse("2026-11-23T01:00:00Z")));
  check("a past or equal time is not", !isFuture("2026-11-23T01:00:00Z", Date.parse("2026-11-23T01:00:00Z")) && !isFuture("2026-11-22T00:00:00Z", Date.parse("2026-11-23T01:00:00Z")));
  check("last attempt shows the http status", describeLastAttempt({ responseStatus: 503, error: "http_503" }) === "HTTP 503");
  check("last attempt shows the error when there was no response", describeLastAttempt({ responseStatus: null, error: "timeout" }) === "timeout");
  check("no attempt reads no attempt yet", describeLastAttempt(null) === "no attempt yet");
}

function checkPayload(): void {
  const small = previewPayload({ a: 1 }, 1024);
  check("a small payload is pretty json and whole", small.text === '{\n  "a": 1\n}' && !small.truncated);
  const html = previewPayload({ note: "<script>alert(1)</script>" }, 1024);
  check("markup stays text, escaping is left to the renderer", html.text.includes("<script>alert(1)</script>") && !html.truncated);
  const big = previewPayload({ blob: "x".repeat(5000) }, 1000);
  check("a big payload is cut at the limit and flagged", big.truncated && new TextEncoder().encode(big.text).length <= 1000);
  check("a payload exactly at the limit is not cut", !previewPayload("x".repeat(8), 10).truncated);
  check("a null payload is the text null", previewPayload(null, 100).text === "null");
}

function main(): void {
  try {
    checkStatus();
    checkCookie();
    checkQuery();
    checkFilters();
    checkFormat();
    checkPayload();
    console.log("check web passed");
  } catch (err) {
    if (!(err instanceof CheckFailure)) console.error(`check web crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

main();
