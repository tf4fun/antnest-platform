import { DomainError } from "../domain/errors.js";
import { parsePermissionDecision, permissionRule } from "../domain/tool-permissions.js";
import type {
  PermissionRepository,
  PermissionOwner,
  PermissionRequest,
  PermissionResult,
  ToolPermissionPort,
} from "../ports/tool-permissions.js";
import type { AccessService } from "./access-service.js";
import type { PermissionConnections } from "./permission-connections.js";

export class ToolPermissions implements ToolPermissionPort {
  public constructor(
    private readonly repository: PermissionRepository,
    private readonly connections: PermissionConnections,
    private readonly access: Pick<AccessService, "assert" | "withAccess">,
  ) {}

  public async request(
    input: Parameters<ToolPermissionPort["request"]>[0],
  ): Promise<PermissionResult> {
    input.signal.throwIfAborted();
    const request = structuredClone({
      runId: input.runId,
      sessionId: input.sessionId,
      call: input.call,
      tool: input.tool,
    });
    const owner = await this.repository.open(request);
    const result = await (async () => {
      try {
        input.signal.throwIfAborted();
        const response = await this.connections.request(
          request,
          owner,
          input.signal,
          (connection) => this.access.assert(connection.binding),
        );
        return { decision: parsePermissionDecision(response), reason: "client_response" };
      } catch (error) {
        return {
          decision: "cancelled" as const,
          reason: input.signal.aborted
            ? "run_cancelled"
            : error instanceof DomainError
              ? error.code
              : "permission_unavailable",
        };
      }
    })();
    input.authoritySignal.throwIfAborted();
    const final = input.signal.aborted
      ? { decision: "cancelled" as const, reason: "run_cancelled" }
      : result;
    return this.commit(input, request, owner, final);
  }

  private async commit(
    input: Parameters<ToolPermissionPort["request"]>[0],
    request: PermissionRequest,
    owner: PermissionOwner,
    result: PermissionResult,
  ): Promise<PermissionResult> {
    if (result.decision === "cancelled") return this.persist(input, request, result);
    try {
      return await this.access.withAccess(owner, (revision) => {
        const current =
          revision === owner.accessRevision
            ? result
            : { decision: "cancelled" as const, reason: "permission_stale" };
        return this.persist(input, request, current);
      });
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        !["access_denied", "configuration_not_ready"].includes(error.code)
      )
        throw error;
      return this.persist(input, request, { decision: "cancelled", reason: error.code });
    }
  }

  private async persist(
    input: Parameters<ToolPermissionPort["request"]>[0],
    request: PermissionRequest,
    result: PermissionResult,
  ): Promise<PermissionResult> {
    const rule = permissionRule(request.tool, result.decision);
    const committed = await this.repository.decide({
      request,
      result,
      ...(rule === undefined ? {} : { rule }),
      signal: input.signal,
      authoritySignal: input.authoritySignal,
    });
    const recorded = committed
      ? result
      : { decision: "cancelled" as const, reason: "permission_stale" };
    return recorded;
  }
}
