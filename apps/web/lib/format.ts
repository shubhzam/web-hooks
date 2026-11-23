const INVALID_DATE = "invalid date";
const PERCENT = 100;

// every time on the dashboard is utc and says so
export function formatUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return INVALID_DATE;
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function isFuture(iso: string, nowMs: number): boolean {
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms > nowMs;
}

// one decimal, or n/a while nothing has finished
export function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * PERCENT).toFixed(1)}%`;
}

interface LastAttempt {
  responseStatus: number | null;
  error: string | null;
}

export function describeLastAttempt(attempt: LastAttempt | null): string {
  if (attempt === null) return "no attempt yet";
  if (attempt.responseStatus !== null) return `HTTP ${attempt.responseStatus}`;
  return attempt.error ?? "no response";
}

export interface PayloadPreview {
  text: string;
  truncated: boolean;
}

// pretty json as plain text, cut at a byte limit. the caller renders it as text, never as html
export function previewPayload(payload: unknown, maxBytes: number): PayloadPreview {
  const text = JSON.stringify(payload, null, 2) ?? "null";
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes)), truncated: true };
}
