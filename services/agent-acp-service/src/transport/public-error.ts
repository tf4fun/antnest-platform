import { resolveErrorDefinition } from "../domain/error-catalog.js";
import type { ErrorSurface } from "../domain/error-catalog.js";
import { DomainError } from "../domain/errors.js";
import { RunRecoveryRequiredError } from "../ports/acp-application.js";

type PublicError = Readonly<{
  jsonRpcCode: number | null;
  httpStatus: number;
  message: string;
  data: Readonly<{
    code: string;
    retryable: boolean;
    retry_after_ms?: number;
  }>;
}>;

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
  const data = Object.freeze({
    code: definition.code,
    retryable: definition.retryable,
    ...(definition.retryAfterMs === undefined ? {} : { retry_after_ms: definition.retryAfterMs }),
  });
  return Object.freeze({
    jsonRpcCode: definition.jsonRpcCode,
    httpStatus: definition.httpStatus,
    message: definition.message,
    data,
  });
}
