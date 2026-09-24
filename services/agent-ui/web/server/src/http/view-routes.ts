import { HistoryCapacityError } from "../bridge/compact-transcript.ts";
import { OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import { StreamCapacityError } from "../bridge/stream-journal.ts";
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
        "unauthenticated",
        "Trusted identity is missing",
        "login",
      );
    if (scope.agentId !== agentId)
      return error(403, "access_denied", "Agent access denied", "none");
    try {
      return json(await dependencies.read(scope, sessionId));
    } catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity !== null) return capacity;
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, "workspace_deadline_exceeded", "Operation reconciliation timed out", "retry_read");
      if (cause instanceof HistoryCapacityError)
        return error(
          429,
          "history_capacity_exceeded",
          "Session history exceeds Bridge capacity",
          "retry_read",
        );
      if (cause instanceof StreamCapacityError)
        return error(429, "stream_capacity_exceeded", "Workspace stream exceeds Bridge capacity", "retry_read");
      return error(
        503,
        "history_unavailable",
        "Session view is unavailable",
        "retry_read",
      );
    }
  };
}
