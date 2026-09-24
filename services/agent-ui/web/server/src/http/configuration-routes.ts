import { z } from "zod";
import { HistoryCapacityError } from "../bridge/compact-transcript.ts";
import { ConfigurationConflictError } from "../bridge/configuration-token.ts";
import { OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import type { BridgeScope } from "../bridge/registry.ts";
import {
  BodyTooLargeError,
  bridgeCapacityResponse,
  error,
  json,
  readBody,
  routeParts,
  trustedScope,
} from "./command-routes.ts";

const id = z.string().min(1).max(200);
const schema = z.strictObject({
  configId: id,
  value: z.union([z.string(), z.boolean()]),
  expectedConfigurationToken: z.string().min(1).max(4096),
});

export function createConfigurationHandler(dependencies: {
  apply(
    scope: BridgeScope,
    sessionId: string,
    configId: string,
    value: string | boolean,
    token: string,
  ): Promise<unknown>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const parts = routeParts(new URL(request.url).pathname);
    if (parts === null) return null;
    const [agentId, sessionId, resource, extra] = parts;
    if (resource !== "configuration" || extra !== undefined) return null;
    if (request.method !== "POST")
      return error(405, "method_not_allowed", "Method is not allowed", "none");
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
      const body = schema.parse(await readBody(request, 8192));
      return json(
        await dependencies.apply(
          scope,
          sessionId!,
          body.configId,
          body.value,
          body.expectedConfigurationToken,
        ),
      );
    } catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity !== null) return capacity;
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, "workspace_deadline_exceeded", "Operation reconciliation timed out", "retry_read");
      if (cause instanceof BodyTooLargeError)
        return error(
          413,
          "request_too_large",
          "Configuration request exceeds the limit",
          "none",
        );
      if (cause instanceof z.ZodError || cause instanceof SyntaxError)
        return error(
          422,
          "invalid_request",
          "Configuration request is invalid",
          "none",
        );
      if (cause instanceof ConfigurationConflictError)
        return error(
          409,
          "configuration_conflict",
          "Configuration choice is stale",
          "refresh",
        );
      if (cause instanceof HistoryCapacityError)
        return error(
          429,
          "history_capacity_exceeded",
          "Session history exceeds Bridge capacity",
          "retry_read",
        );
      return error(
        503,
        "upstream_unavailable",
        "Configuration is unavailable",
        "retry_read",
      );
    }
  };
}
