import { context, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { SEMCONV } from "./semconv.gen.js";
import { normalizeAttributes } from "./names.js";
import type { RunExecutionSnapshot } from "../domain/types.js";
import type { ModelRequest, ModelResult } from "../ports/model.js";
import type { ToolCallInput } from "../ports/tools.js";
import { record } from "./diagnostics.js";

export function snapshotAttributes(snapshot: RunExecutionSnapshot): Attributes {
  const configuration = snapshot.executionSpec.configuration;
  return {
    [SEMCONV.ANTNEST_ORGANIZATION_ID]: snapshot.organizationId,
    [SEMCONV.ANTNEST_PROVIDER_CONNECTION_ID]: snapshot.providerConnectionId,
    [SEMCONV.ANTNEST_CONFIGURATION_REVISION]: snapshot.configurationRevision,
    [SEMCONV.ANTNEST_AGENT_REVISION]: snapshot.agentSpecRevision,
    [SEMCONV.ANTNEST_EXECUTION_REVISION]: snapshot.executionRevision,
    [SEMCONV.ANTNEST_RUNTIME_REVISION]: snapshot.runtime.revision,
    [SEMCONV.ANTNEST_RUNTIME_EXECUTION_ID]: snapshot.runtime.executionId,
    [SEMCONV.ANTNEST_DEADLINE]: snapshot.deadlineAt.toISOString(),
    ...(configuration === undefined
      ? {}
      : {
          [SEMCONV.ANTNEST_MODEL_PROFILE_ID]: configuration.modelProfileId,
          [SEMCONV.ANTNEST_AUTHORIZATION_MODE]: configuration.authorization.mode,
        }),
  };
}

export function modelRequest(request: ModelRequest): void {
  trace.getSpan(context.active())?.setAttributes(
    normalizeAttributes({
      ...snapshotAttributes(request.snapshot),
      [SEMCONV.ANTNEST_CONTEXT_MESSAGE_COUNT]: request.messages.length,
      [SEMCONV.ANTNEST_CONTEXT_TOOL_COUNT]: request.tools.length,
      [SEMCONV.ANTNEST_MODEL_MAX_OUTPUT_TOKENS]:
        request.snapshot.executionSpec.model.maxOutputTokens,
    }),
  );
}

export function modelResponse(result: ModelResult): void {
  trace.getSpan(context.active())?.setAttributes(
    normalizeAttributes({
      "gen_ai.usage.input_tokens": result.usage.inputTokens,
      "gen_ai.usage.output_tokens": result.usage.outputTokens,
      [SEMCONV.ANTNEST_MODEL_RESULT_KIND]: result.kind,
    }),
  );
}

export function toolRequest(input: ToolCallInput): void {
  trace
    .getSpan(context.active())
    ?.setAttributes(normalizeAttributes(snapshotAttributes(input.snapshot)));
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
  span?.setAttributes(normalizeAttributes({ [SEMCONV.ANTNEST_OUTCOME]: outcome }));
  if (outcome !== "ok" && outcome !== "cancelled") {
    span?.setStatus({ code: SpanStatusCode.ERROR });
    span?.setAttribute(
      "error.type",
      outcome === "tool_error" ? "mcp_tool_error" : `run_${outcome}`,
    );
  }
}
