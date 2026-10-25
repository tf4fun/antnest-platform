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
  data: Readonly<{
    code: string;
    retryable: boolean;
    retry_after_ms?: number;
    details?: Readonly<{ budget: Readonly<ModelBudgetFact> }>;
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
  const details =
    error instanceof ModelBudgetExceededError
      ? budgetErrorDetails(definition.code, {
          scope: error.scope,
          limit: error.limit,
          used: error.used,
        })
      : undefined;
  const data = Object.freeze({
    ...(details === undefined ? {} : { details }),
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

// The route selects its existing public classification before projection. This
// keeps dependency defaults and non-enumerating resource errors route-specific.
export function httpFailure(code: string) {
  const definition = resolveErrorDefinition(code, "http");
  return {
    status: definition.httpStatus,
    body: {
      code: definition.code,
      message: definition.message,
      retryable: definition.retryable,
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
