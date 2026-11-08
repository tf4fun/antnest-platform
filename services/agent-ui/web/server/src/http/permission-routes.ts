import { z } from "zod";
import { agentIdSchema } from "../protocol/resource-ids.ts";
import { ERROR_CODES } from "../errors.gen.ts";
import { ReplayCapacityError } from "../bridge/replay-load-gate.ts";
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
      return error(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Method is not allowed", "none");
    let agentId: string;
    let permissionId: string;
    try {
      agentId = decodeURIComponent(raw[0]!);
      permissionId = decodeURIComponent(raw[2]!);
      agentIdSchema.parse(agentId);
      id.parse(permissionId);
      if (/[/\\\x00-\x1f]/u.test(agentId + permissionId)) throw new Error();
    } catch {
      return error(
        422,
        ERROR_CODES.INVALID_REQUEST,
        "Permission path is invalid",
        "none",
      );
    }
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
        return error(504, ERROR_CODES.WORKSPACE_DEADLINE_EXCEEDED, "Operation reconciliation timed out", "retry_read");
      if (cause instanceof BodyTooLargeError)
        return error(
          413,
          ERROR_CODES.REQUEST_TOO_LARGE,
          "Permission request exceeds the limit",
          "none",
        );
      if (cause instanceof z.ZodError || cause instanceof SyntaxError)
        return error(
          422,
          ERROR_CODES.INVALID_REQUEST,
          "Permission request is invalid",
          "none",
        );
      if (cause instanceof PermissionDecisionError)
        return error(
          409,
          cause.code,
          "Permission request is no longer current",
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
        "Permission decision is unavailable",
        "retry_read",
      );
    }
  };
}
