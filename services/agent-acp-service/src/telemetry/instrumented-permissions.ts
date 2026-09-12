import type { ToolPermissionPort } from "../ports/tool-permissions.js";
import type { TelemetryPort } from "../ports/telemetry.js";
import { context, trace } from "@opentelemetry/api";

export class InstrumentedToolPermissions implements ToolPermissionPort {
  public constructor(
    private readonly delegate: ToolPermissionPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  public request(
    input: Parameters<ToolPermissionPort["request"]>[0],
  ): ReturnType<ToolPermissionPort["request"]> {
    const attributes = {
      "run.id": input.runId,
      "session.id": input.sessionId,
      "tool.call_id": input.call.id,
    };
    return this.telemetry.span("acp.permission.wait", attributes, async () => {
      const result = await this.delegate.request(input);
      trace
        .getSpan(context.active())
        ?.setAttribute(
          "antnest.outcome",
          result.decision === "cancelled"
            ? "cancelled"
            : result.decision.startsWith("reject")
              ? "rejected"
              : "ok",
        );
      this.telemetry.count("antnest.acp.permission.decisions", {
        decision: result.decision,
        reason: result.reason,
      });
      this.telemetry.log("info", "permission_decided", {
        ...attributes,
        decision: result.decision,
        reason: result.reason,
      });
      return result;
    });
  }
}
