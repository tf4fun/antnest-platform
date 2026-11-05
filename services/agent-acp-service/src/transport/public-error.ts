import { createError, ERROR_METADATA } from "../errors.gen.js";
import type { ApiError } from "../errors.gen.js";
import { resolveErrorDefinition } from "../domain/error-catalog.js";
import type { ErrorSurface } from "../domain/error-catalog.js";
import {
  budgetFactSchema,
  ModelBudgetExceededError,
  type ModelBudgetFact,
} from "../domain/model-budget.js";
import { DomainError } from "../domain/errors.js";
import { RunRecoveryRequiredError } from "../ports/acp-application.js";

type PublicError = Readonly<{
  jsonRpcCode: number | null;
  httpStatus: number;
  message: string;
  data: ApiError &
    Readonly<{
      retry_after_ms?: number;
      details?: Readonly<{ budget: Readonly<ModelBudgetFact> }>;
    }>;
}>;

export function commonError(
  code: string,
  message: string,
  retryable: boolean,
  requestId = "",
): ApiError {
  const meta = Object.hasOwn(ERROR_METADATA, code) ? ERROR_METADATA[code] : undefined;
  const envelope = createError(code, message, requestId);
  if (meta !== undefined) envelope.retryable = retryable;
  return envelope;
}

export function errorHeaders(body: unknown): Record<string, string> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (typeof body === "object" && body !== null && Object.hasOwn(body, "request_id")) {
    const value = (body as { request_id?: unknown }).request_id;
    if (typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value))
      headers["x-request-id"] = value;
  }
  return headers;
}

export function publicError(error: unknown, surface: ErrorSurface): PublicError {
  // The empty key cannot be registered by the catalog schema, so an untyped
  // failure always resolves to the canonical fallback rather than a forged code.
  const code =
    error instanceof RunRecoveryRequiredError
      ? "database_error"
      : error instanceof DomainError
        ? error.code
        : "";
  const definition = resolveErrorDefinition(code, surface);
  const details =
    error instanceof ModelBudgetExceededError
      ? budgetErrorDetails(definition.code, {
          scope: error.scope,
          limit: error.limit,
          used: error.used,
        })
      : undefined;
  const envelope = commonError(definition.code, definition.message, definition.retryable);
  const data = Object.freeze({
    code: envelope.code,
    category: envelope.category,
    message: envelope.message,
    retryable: envelope.retryable,
    request_id: envelope.request_id,
    ...(details === undefined ? {} : { details }),
    ...(definition.retryAfterMs === undefined ? {} : { retry_after_ms: definition.retryAfterMs }),
  });
  return Object.freeze({
    jsonRpcCode: definition.jsonRpcCode,
    httpStatus: definition.httpStatus,
    message: definition.message,
    data,
  });
}

// The route selects its existing public classification before projection. This
// keeps dependency defaults and non-enumerating resource errors route-specific.
export function httpFailure(code: string) {
  const definition = resolveErrorDefinition(code, "http");
  return {
    status: definition.httpStatus,
    body: {
      ...commonError(definition.code, definition.message, definition.retryable),
      ...(definition.retryAfterMs === undefined ? {} : { retry_after_ms: definition.retryAfterMs }),
    },
  };
}

/** Only a trusted typed error or persisted Run outcome supplies this projection. */
export function budgetErrorDetails(
  code: string,
  fact: unknown,
): Readonly<{ budget: Readonly<ModelBudgetFact> }> | undefined {
  if (code !== "budget_exceeded") return undefined;
  const parsed = budgetFactSchema.safeParse(fact);
  if (!parsed.success) return undefined;
  return Object.freeze({ budget: Object.freeze(parsed.data) });
}
