import { context, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import type { RunExecutionSnapshot } from "../domain/types.js";
import type { ModelRequest, ModelResult } from "../ports/model.js";
import type { ToolCallInput } from "../ports/tools.js";
import { record } from "./diagnostics.js";

export function snapshotAttributes(snapshot: RunExecutionSnapshot): Attributes {
  const configuration = snapshot.executionSpec.configuration;
  return {
    "antnest.organization.id": snapshot.organizationId,
    "antnest.provider.connection_id": snapshot.providerConnectionId,
    "antnest.configuration.revision": snapshot.configurationRevision,
    "antnest.agent.revision": snapshot.agentSpecRevision,
    "antnest.execution.revision": snapshot.executionRevision,
    "antnest.runtime.revision": snapshot.runtime.revision,
    "antnest.runtime.execution_id": snapshot.runtime.executionId,
    "antnest.deadline": snapshot.deadlineAt.toISOString(),
    ...(configuration === undefined
      ? {}
      : {
          "antnest.model.profile_id": configuration.modelProfileId,
          "antnest.authorization.mode": configuration.authorization.mode,
        }),
  };
}

export function modelRequest(request: ModelRequest): void {
  trace.getSpan(context.active())?.setAttributes({
    ...snapshotAttributes(request.snapshot),
    "antnest.context.message_count": request.messages.length,
    "antnest.context.tool_count": request.tools.length,
    "antnest.model.max_output_tokens": request.snapshot.executionSpec.model.maxOutputTokens,
  });
}

export function modelResponse(result: ModelResult): void {
  trace.getSpan(context.active())?.setAttributes({
    "gen_ai.usage.input_tokens": result.usage.inputTokens,
    "gen_ai.usage.output_tokens": result.usage.outputTokens,
    "antnest.model.result.kind": result.kind,
  });
}

export function toolRequest(input: ToolCallInput): void {
  trace.getSpan(context.active())?.setAttributes(snapshotAttributes(input.snapshot));
}

export function resultOutcome(
  result: unknown,
): "ok" | "tool_error" | "failed" | "unresolved" | "cancelled" {
  const value = record(result);
  if (value.isError === true) return "tool_error";
  if (
    value.terminalClass === "failed" ||
    value.terminalClass === "unresolved" ||
    value.terminalClass === "cancelled"
  )
    return value.terminalClass;
  return "ok";
}

export function recordResult(result: unknown): void {
  const outcome = resultOutcome(result);
  const span = trace.getSpan(context.active());
  span?.setAttribute("antnest.outcome", outcome);
  if (outcome !== "ok" && outcome !== "cancelled") {
    span?.setStatus({ code: SpanStatusCode.ERROR });
    span?.setAttribute(
      "error.type",
      outcome === "tool_error" ? "mcp_tool_error" : `run_${outcome}`,
    );
  }
}
