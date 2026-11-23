export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "not_found"
  | "payload_too_large"
  | "endpoint_url_exists"
  | "delivery_not_replayable"
  | "endpoint_inactive"
  | "internal_error"
  | "broker_unavailable";

const statusByCode: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  not_found: 404,
  payload_too_large: 413,
  endpoint_url_exists: 409,
  delivery_not_replayable: 409,
  endpoint_inactive: 409,
  internal_error: 500,
  broker_unavailable: 503,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

// an error we expect and know how to show the client, anything else becomes a 500
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  // extra response headers, for example Retry-After
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, message: string, details?: unknown, headers: Record<string, string> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.details = details;
    this.headers = headers;
  }

  toBody(): ErrorBody {
    const error = { code: this.code, message: this.message };
    return { error: this.details === undefined ? error : { ...error, details: this.details } };
  }
}

export const notFound = (message = "resource not found") => new AppError("not_found", message);
export const unauthorized = () => new AppError("unauthorized", "missing or invalid api key");
