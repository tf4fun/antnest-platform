import { ReplayCapacityError } from "../bridge/replay-load-gate.ts";
import { ERROR_CODES } from "../errors.gen.ts";
import { OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import { StreamCapacityError } from "../bridge/stream-journal.ts";
import { SessionNotFoundError } from "../adapters/acp-http.ts";
import type { BridgeScope } from "../bridge/registry.ts";
import { bridgeCapacityResponse, error, json, routeParts, trustedScope } from "./command-routes.ts";

export function createViewHandler(dependencies: {
  read(scope: BridgeScope, sessionId: string): Promise<unknown>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const parts = routeParts(new URL(request.url).pathname);
    if (parts === null) return null;
    const [agentId, sessionId, resource, extra] = parts;
    if (
      agentId === undefined ||
      sessionId === undefined ||
      resource !== "view" ||
      extra !== undefined ||
      request.method !== "GET"
    )
      return null;
    const scope = trustedScope(request);
    if (scope === null)
      return error(
        401,
        ERROR_CODES.UNAUTHENTICATED,
        "Trusted identity is missing",
        "login",
      );
    if (scope.agentId !== agentId)
      return error(403, ERROR_CODES.ACCESS_DENIED, "Agent access denied", "none");
    try {
      return json(await dependencies.read(scope, sessionId));
    } catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity !== null) return capacity;
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, ERROR_CODES.WORKSPACE_DEADLINE_EXCEEDED, "Operation reconciliation timed out", "retry_read");
      if (cause instanceof SessionNotFoundError)
        return error(404, ERROR_CODES.SESSION_NOT_FOUND, "Session not found", "none");
      if (cause instanceof ReplayCapacityError)
        return error(
          429,
          ERROR_CODES.REPLAY_CAPACITY_EXCEEDED,
          "Concurrent replay queue is full",
          "retry_read",
        );
      if (cause instanceof StreamCapacityError)
        return error(429, ERROR_CODES.STREAM_CAPACITY_EXCEEDED, "Workspace stream exceeds Bridge capacity", "retry_read");
      return error(
        503,
        ERROR_CODES.HISTORY_UNAVAILABLE,
        "Session view is unavailable",
        "retry_read",
      );
    }
  };
}
