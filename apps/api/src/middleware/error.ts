import type { ErrorRequestHandler, RequestHandler } from "express";
import * as z from "zod";
import { isEndpointUrlViolation } from "../lib/db-errors.js";
import { describeError } from "../lib/describe-error.js";
import { AppError, notFound } from "../lib/errors.js";
import { BrokerUnavailableError } from "../lib/kafka.js";

// errors thrown by express.json when the body is not usable
const bodyParserErrorSchema = z.object({
  type: z.enum(["entity.parse.failed", "entity.too.large", "encoding.unsupported", "charset.unsupported"]),
});

function validationDetails(err: z.ZodError) {
  return err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof z.ZodError) {
    return new AppError("validation_error", "request validation failed", validationDetails(err));
  }
  if (isEndpointUrlViolation(err)) {
    return new AppError("endpoint_url_exists", "an endpoint with this url already exists");
  }
  const bodyError = bodyParserErrorSchema.safeParse(err);
  if (bodyError.success) {
    return bodyError.data.type === "entity.too.large"
      ? new AppError("payload_too_large", "request body is too large")
      : new AppError("validation_error", "request body is not valid json");
  }
  if (err instanceof BrokerUnavailableError) {
    // the event was not accepted, the caller should retry the same event id
    return new AppError("broker_unavailable", "event could not be accepted, retry shortly", undefined, {
      "Retry-After": "1",
    });
  }
  return new AppError("internal_error", "internal server error");
}

export const routeNotFound: RequestHandler = (_req, _res, next) => {
  next(notFound("route not found"));
};

// express recognises an error handler by its four arguments, so _next has to stay
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const appError = toAppError(err);
  if (appError.code === "internal_error") {
    console.error(`request failed: ${describeError(err)}`);
  }
  res.status(appError.status).set(appError.headers).json(appError.toBody());
};
