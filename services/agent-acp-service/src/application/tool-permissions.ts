import { DomainError } from "../domain/errors.js";
import { parsePermissionDecision, permissionRule } from "../domain/tool-permissions.js";
import type {
  PermissionRepository,
  PermissionResult,
  ToolPermissionPort,
} from "../ports/tool-permissions.js";
import type { AccessService } from "./access-service.js";
import type { PermissionConnections } from "./permission-connections.js";

export class ToolPermissions implements ToolPermissionPort {
  public constructor(
    private readonly repository: PermissionRepository,
    private readonly connections: PermissionConnections,
    private readonly access: Pick<AccessService, "assert">,
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
    const rule = permissionRule(request.tool, final.decision);
    const committed = await this.repository.decide({
      request,
      result: final,
      ...(rule === undefined ? {} : { rule }),
      signal: input.signal,
      authoritySignal: input.authoritySignal,
    });
    const recorded = committed
      ? final
      : { decision: "cancelled" as const, reason: "permission_stale" };
    return recorded;
  }
}
