// pure: turns whatever a failed request threw into one short code. the code is what gets stored
// and logged, the raw message is dropped because it can contain urls or response details

export type FailureCode =
  | "timeout"
  | "blocked_address"
  | "connection_refused"
  | "dns_error"
  | "tls_error"
  | "network_error";

// what the http client throws, so callers only ever see a code
export class DeliveryFailure extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "DeliveryFailure";
    this.code = code;
  }
}

const MAX_CAUSE_DEPTH = 5;
const TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"]);
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "HOSTNAME_MISMATCH",
]);

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

// the error itself, then its cause and the errors of an AggregateError, a few levels deep
function unwrap(error: unknown, depth = 0): unknown[] {
  if (depth > MAX_CAUSE_DEPTH || !(error instanceof Error)) return [error];
  const nested: unknown[] = [];
  if (error.cause !== undefined) nested.push(...unwrap(error.cause, depth + 1));
  if (error instanceof AggregateError) {
    for (const inner of error.errors) nested.push(...unwrap(inner, depth + 1));
  }
  return [error, ...nested];
}

function classifyOne(error: unknown): FailureCode | null {
  if (error instanceof DeliveryFailure) return error.code;
  const code = codeOf(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError" || TIMEOUT_CODES.has(code)) return "timeout";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (DNS_CODES.has(code)) return "dns_error";
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) return "tls_error";
  return null;
}

export function describeFailure(error: unknown): FailureCode {
  for (const candidate of unwrap(error)) {
    const code = classifyOne(candidate);
    if (code !== null) return code;
  }
  return "network_error";
}
