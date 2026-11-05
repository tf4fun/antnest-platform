import { z } from "zod";
import { ERROR_CODES } from "../errors.gen.ts";
import { ReplayCapacityError } from "../bridge/replay-load-gate.ts";
import { ConfigurationConflictError } from "../bridge/configuration-token.ts";
import { OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import type { BridgeScope } from "../bridge/registry.ts";
import {
  BodyTooLargeError,
  bridgeCapacityResponse,
  error,
  json,
  missingSessionResponse,
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
      return error(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Method is not allowed", "none");
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
      const missing = missingSessionResponse(cause);
      if (missing !== null) return missing;
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, ERROR_CODES.WORKSPACE_DEADLINE_EXCEEDED, "Operation reconciliation timed out", "retry_read");
      if (cause instanceof BodyTooLargeError)
        return error(
          413,
          ERROR_CODES.REQUEST_TOO_LARGE,
          "Configuration request exceeds the limit",
          "none",
        );
      if (cause instanceof z.ZodError || cause instanceof SyntaxError)
        return error(
          422,
          ERROR_CODES.INVALID_REQUEST,
          "Configuration request is invalid",
          "none",
        );
      if (cause instanceof ConfigurationConflictError)
        return error(
          409,
          ERROR_CODES.CONFIGURATION_CONFLICT,
          "Configuration choice is stale",
          "refresh",
        );
      if (cause instanceof ReplayCapacityError)
        return error(
          429,
          ERROR_CODES.REPLAY_CAPACITY_EXCEEDED,
          "Concurrent replay queue is full",
          "retry_read",
        );
      return error(
        503,
        ERROR_CODES.UPSTREAM_UNAVAILABLE,
        "Configuration is unavailable",
        "retry_read",
      );
    }
  };
}
