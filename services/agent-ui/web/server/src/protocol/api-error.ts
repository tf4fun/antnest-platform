import { createError, ERROR_CODES, ERROR_METADATA } from "../errors.gen.ts";
import type { ApiError } from "../errors.gen.ts";
import type { OperationError } from "./agent-view-delta.ts";

type Recovery = "refresh" | "query_operation" | "login" | "retry_read" | "none";

export function workspaceError(
  code: string,
  message: string,
  recovery: Recovery,
  requestId = "",
  retryable?: boolean,
  operationId?: string,
): OperationError & ApiError {
  const meta = Object.hasOwn(ERROR_METADATA, code) ? ERROR_METADATA[code] : undefined;
  const envelope = createError(code, message, requestId);
  if (meta === undefined) {
    return {
      code: ERROR_CODES.INTERNAL,
      category: "internal",
      message: envelope.message,
      retryable: false,
      requestId: envelope.request_id,
      request_id: envelope.request_id,
      recovery: "none",
    };
  }
  const result: OperationError & ApiError = {
    ...envelope,
    code,
    category: envelope.category as NonNullable<OperationError["category"]>,
    message,
    retryable: retryable ?? meta.retryable,
    requestId: envelope.request_id,
    request_id: envelope.request_id,
    recovery,
    details: { recovery, ...(operationId === undefined ? {} : { operationId }) },
    ...(operationId === undefined ? {} : { operationId }),
  };
  return result;
}
