import { z } from "zod";
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
    if (request.method !== "POST") return error(405, "method_not_allowed", "Method is not allowed", "none");
    const scope = trustedScope(request);
    if (!scope) return error(401, "unauthenticated", "Trusted identity is missing", "login");
    let agentId: string;
    try { agentId = decodeURIComponent(match[1]!); }
    catch { return error(422, "invalid_request", "Agent ID is invalid", "none"); }
    if (scope.agentId !== agentId) return error(403, "access_denied", "Agent access denied", "none");
    if (url.search) return error(422, "invalid_request", "Command query is invalid", "none");
    let body: ControlRequest;
    try { body = controlRequestSchema.parse(await readBody(request, 16384)); }
    catch (cause) {
      return cause instanceof BodyTooLargeError
        ? error(413, "request_too_large", "Command request exceeds the limit", "none")
        : error(422, "invalid_request", "Command request is invalid", "none");
    }
    try { return json(controlResultSchema.parse(await dependencies.execute(scope, body))); }
    catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity) return capacity;
      if (cause instanceof AgentAccessRevokedError) return error(403, "access_denied", "Agent access denied", "none");
      if (cause instanceof SessionNotFoundError) return error(404, "session_not_found", "Session not found", "none");
      if (cause instanceof ConfigurationConflictError)
        return error(409, "configuration_conflict", "Configuration choice is stale", "refresh");
      if (cause instanceof OperationConflictError)
        return error(409, "operation_conflict", "Operation target is stale", "refresh");
      if (cause instanceof ControlError) return error(cause.status, cause.code, cause.message, cause.status === 409 ? "refresh" : "none");
      if (cause instanceof ReplayCapacityError) return error(429, "replay_capacity_exceeded", "Concurrent replay queue is full", "retry_read");
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, "workspace_deadline_exceeded", "Operation reconciliation timed out", "retry_read");
      if (cause instanceof z.ZodError) return error(503, "invalid_command_result", "Command result could not be verified", "refresh");
      return error(503, "upstream_unavailable", "Command outcome is unavailable. Refresh before retrying.", "refresh");
    }
  };
}
