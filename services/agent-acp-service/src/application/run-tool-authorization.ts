import { toolPermission, type Authorization } from "../domain/session-configuration.js";
import { permissionRule } from "../domain/tool-permissions.js";
import type { ToolPermissionPort } from "../ports/tool-permissions.js";
import type { PreparedToolCall } from "./tool-preflight.js";
import type { RunTurnInput } from "./turn-runner.js";
import type { PermissionJudge } from "./permission-judge.js";

export class RunToolAuthorization {
  private readonly learned: Authorization["toolRules"] = [];
  public constructor(
    private readonly permissions?: ToolPermissionPort,
    private readonly judge?: Pick<PermissionJudge, "readOnly">,
  ) {}

  public async check(input: RunTurnInput, prepared: PreparedToolCall): Promise<string | null> {
    const authorization = input.snapshot.executionSpec.configuration?.authorization;
    if (authorization === undefined) return null;
    const permission = toolPermission(
      { ...authorization, toolRules: [...this.learned, ...authorization.toolRules] },
      prepared.tool,
    );
    if (permission === "allow") return null;
    if (permission === "deny")
      return "Tool execution is disabled by the Session authorization policy.";
    if (
      authorization.mode === "smart_approve" &&
      prepared.tool.source !== "client" &&
      prepared.tool.annotations?.readOnlyHint === undefined &&
      prepared.tool.annotations?.destructiveHint !== true &&
      (await this.judge?.readOnly(input, prepared))
    )
      return null;
    if (this.permissions === undefined)
      return "Tool requires permission. Permission interaction is not available; the tool was not executed.";
    const result = await this.permissions.request({
      runId: input.runId,
      sessionId: input.sessionId,
      ...prepared,
      signal: input.signal,
      authoritySignal: input.authoritySignal,
    });
    input.signal.throwIfAborted();
    const rule = permissionRule(prepared.tool, result.decision);
    if (rule !== undefined) this.learned.unshift(rule);
    if (result.decision === "allow_once" || result.decision === "allow_always") return null;
    return `Tool was not executed: ${result.decision} (${result.reason}).`;
  }
}
