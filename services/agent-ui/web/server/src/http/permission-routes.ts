import { z } from "zod";
import { HistoryCapacityError } from "../bridge/compact-transcript.ts";
import { PermissionDecisionError } from "../bridge/permission-inbox.ts";
import { OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import type { BridgeScope } from "../bridge/registry.ts";
import {
  BodyTooLargeError,
  bridgeCapacityResponse,
  error,
  json,
  readBody,
  trustedScope,
} from "./command-routes.ts";

const prefix = "/api/app/workspace/v1/agents/";
const id = z.string().min(1).max(200);
const decision = z.strictObject({
  generation: z.number().int().nonnegative().safe(),
  optionId: id,
});

export function createPermissionHandler(dependencies: {
  decide(
    scope: BridgeScope,
    permissionId: string,
    generation: number,
    optionId: string,
  ): Promise<unknown>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith(prefix)) return null;
    const raw = pathname.slice(prefix.length).split("/");
    if (raw.length !== 4 || raw[1] !== "permissions" || raw[3] !== "decision")
      return null;
    if (request.method !== "POST")
      return error(405, "method_not_allowed", "Method is not allowed", "none");
    let agentId: string;
    let permissionId: string;
    try {
      agentId = decodeURIComponent(raw[0]!);
      permissionId = decodeURIComponent(raw[2]!);
      id.parse(agentId);
      id.parse(permissionId);
      if (/[/\\\x00-\x1f]/u.test(agentId + permissionId)) throw new Error();
    } catch {
      return error(
        422,
        "invalid_request",
        "Permission path is invalid",
        "none",
      );
    }
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
      const body = decision.parse(await readBody(request, 8192));
      return json(
        await dependencies.decide(
          scope,
          permissionId,
          body.generation,
          body.optionId,
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
          "Permission request exceeds the limit",
          "none",
        );
      if (cause instanceof z.ZodError || cause instanceof SyntaxError)
        return error(
          422,
          "invalid_request",
          "Permission request is invalid",
          "none",
        );
      if (cause instanceof PermissionDecisionError)
        return error(
          409,
          "permission_conflict",
          "Permission request is no longer current",
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
        "Permission decision is unavailable",
        "retry_read",
      );
    }
  };
}
