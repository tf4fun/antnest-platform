import { ReplayCapacityError } from "../bridge/replay-load-gate.ts";
import { AgentAccessRevokedError, SessionNotFoundError } from "../adapters/acp-http.ts";
import { OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import { StreamCapacityError } from "../bridge/stream-journal.ts";
import type { BridgeScope } from "../bridge/registry.ts";
import { bridgeCapacityResponse, error, json, trustedScope } from "./command-routes.ts";

const prefix = "/api/app/workspace/v1/agents/";
const validId = (value: string) =>
  value.length > 0 && value.length <= 200 && !/[/\\\x00-\x1f]/u.test(value);

export function createAgentViewHandler(dependencies: {
  read(scope: BridgeScope, sessionId: string | null, learningStatus?: boolean): Promise<unknown>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return null;
    const suffix = url.pathname.slice(prefix.length).split("/");
    if (suffix.length !== 2 || suffix[1] !== "view") return null;
    let agentId: string;
    try {
      agentId = decodeURIComponent(suffix[0]!);
    } catch {
      return error(422, "invalid_request", "Agent ID is invalid", "none");
    }
    if (request.method !== "GET" || !validId(agentId))
      return error(422, "invalid_request", "Agent view request is invalid", "none");
    const scope = trustedScope(request);
    if (scope === null)
      return error(401, "unauthenticated", "Trusted identity is missing", "login");
    if (scope.agentId !== agentId)
      return error(403, "access_denied", "Agent access denied", "none");
    const sessions = url.searchParams.getAll("sessionId");
    if (sessions.length > 1 || (sessions.length === 1 && !validId(sessions[0]!)))
      return error(422, "invalid_request", "Agent view request is invalid", "none");
    const learningStatus = url.searchParams.getAll("learningStatus");
    if (learningStatus.length > 1 || (learningStatus.length === 1 && learningStatus[0] !== "1"))
      return error(422, "invalid_request", "Learning status selection is invalid", "none");
    try {
      return json(await dependencies.read(scope, sessions[0] ?? null, learningStatus.length === 1));
    } catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity !== null) return capacity;
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, "workspace_deadline_exceeded", "Operation reconciliation timed out", "retry_read");
      if (cause instanceof AgentAccessRevokedError)
        return error(403, "access_denied", "Agent access denied", "none");
      if (cause instanceof SessionNotFoundError)
        return error(404, "session_not_found", "Session not found", "none");
      if (cause instanceof ReplayCapacityError)
        return error(429, "replay_capacity_exceeded", "Concurrent replay queue is full", "retry_read");
      if (cause instanceof StreamCapacityError)
        return error(429, "stream_capacity_exceeded", "Workspace stream exceeds Bridge capacity", "retry_read");
      return error(503, "upstream_unavailable", "Agent view is unavailable", "retry_read");
    }
  };
}
