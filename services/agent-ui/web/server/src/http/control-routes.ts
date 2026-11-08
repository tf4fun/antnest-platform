import { z } from "zod";
import { agentIdSchema } from "../protocol/resource-ids.ts";
import { ERROR_CODES } from "../errors.gen.ts";
import { AgentAccessRevokedError, SessionNotFoundError } from "../adapters/acp-http.ts";
import { ConfigurationConflictError } from "../bridge/configuration-token.ts";
import { OperationConflictError, OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import { ReplayCapacityError } from "../bridge/replay-load-gate.ts";
import type { BridgeScope } from "../bridge/registry.ts";
import { ControlError } from "../commands/execute.ts";
import { controlRequestSchema, controlResultSchema, type ControlRequest, type ControlResult } from "../protocol/workspace-commands.ts";
import { BodyTooLargeError, bridgeCapacityResponse, error, json, readBody, trustedScope } from "./command-routes.ts";

export function createControlHandler(dependencies: {
  execute(scope: BridgeScope, input: ControlRequest): Promise<ControlResult>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    const match = /^\/api\/app\/workspace\/v1\/agents\/([^/]+)\/commands$/u.exec(url.pathname);
    if (!match) return null;
    if (request.method !== "POST") return error(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Method is not allowed", "none");
    const scope = trustedScope(request);
    if (!scope) return error(401, ERROR_CODES.UNAUTHENTICATED, "Trusted identity is missing", "login");
    let agentId: string;
    try { agentId = decodeURIComponent(match[1]!); }
    catch { return error(422, ERROR_CODES.INVALID_REQUEST, "Agent ID is invalid", "none"); }
    if (!agentIdSchema.safeParse(agentId).success) return error(422, ERROR_CODES.INVALID_REQUEST, "Malformed agent", "none");
    if (scope.agentId !== agentId) return error(403, ERROR_CODES.ACCESS_DENIED, "Agent access denied", "none");
    if (url.search) return error(422, ERROR_CODES.INVALID_REQUEST, "Command query is invalid", "none");
    let body: ControlRequest;
    try { body = controlRequestSchema.parse(await readBody(request, 16384)); }
    catch (cause) {
      return cause instanceof BodyTooLargeError
        ? error(413, ERROR_CODES.REQUEST_TOO_LARGE, "Command request exceeds the limit", "none")
        : error(422, ERROR_CODES.INVALID_REQUEST, "Command request is invalid", "none");
    }
    try { return json(controlResultSchema.parse(await dependencies.execute(scope, body))); }
    catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity) return capacity;
      if (cause instanceof AgentAccessRevokedError) return error(403, ERROR_CODES.ACCESS_DENIED, "Agent access denied", "none");
      if (cause instanceof SessionNotFoundError) return error(404, ERROR_CODES.SESSION_NOT_FOUND, "Session not found", "none");
      if (cause instanceof ConfigurationConflictError)
        return error(409, ERROR_CODES.CONFIGURATION_CONFLICT, "Configuration choice is stale", "refresh");
      if (cause instanceof OperationConflictError)
        return error(409, ERROR_CODES.OPERATION_CONFLICT, "Operation target is stale", "refresh");
      if (cause instanceof ControlError) return error(cause.status, cause.code, cause.message, cause.status === 409 ? "refresh" : "none");
      if (cause instanceof ReplayCapacityError) return error(429, ERROR_CODES.REPLAY_CAPACITY_EXCEEDED, "Concurrent replay queue is full", "retry_read");
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, ERROR_CODES.WORKSPACE_DEADLINE_EXCEEDED, "Operation reconciliation timed out", "retry_read");
      if (cause instanceof z.ZodError) return error(503, ERROR_CODES.INVALID_COMMAND_RESULT, "Command result could not be verified", "refresh");
      return error(503, ERROR_CODES.UPSTREAM_UNAVAILABLE, "Command outcome is unavailable. Refresh before retrying.", "refresh");
    }
  };
}
