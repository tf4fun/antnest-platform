import { context, createContextKey, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { boundaryConfig, recordBoundaryError, safeId } from "./diagnostics.js";

type Method = "tools/list" | "tools/call";
type Owner = {
  span: Span;
  method: Method;
  executionId: string;
  active: boolean;
  claimed: boolean;
};
const ownerKey = createContextKey("antnest.runtime-tool-lifecycle");

/** Only the instrumented port can bind its newly created span to one adapter call. */
export async function withRuntimeToolLifecycle<Result>(
  method: Method,
  executionId: string,
  parent: Span | undefined,
  signal: AbortSignal,
  operation: () => Promise<Result>,
): Promise<Result> {
  const span = trace.getActiveSpan();
  const cleared = context.active().deleteValue(ownerKey);
  const admittedExecution = safeId(executionId);
  if (
    boundaryConfig().disabled ||
    !span?.isRecording() ||
    span === parent ||
    admittedExecution === undefined
  )
    return context.with(cleared, operation);

  const owner: Owner = { span, method, executionId, active: true, claimed: false };
  span.setAttributes({
    "antnest.runtime.execution.id": admittedExecution,
    "antnest.mcp.method": method,
    "antnest.mcp.tool_result.outcome": "not_received",
    "antnest.mcp.connection.close.outcome": "not_started",
  });
  try {
    return await context.with(cleared.setValue(ownerKey, owner), operation);
  } finally {
    owner.active = false;
    span.setAttribute("antnest.mcp.caller_cancelled", signal.aborted);
  }
}

/** Claim before any adapter await, so nested dependency calls cannot steal the owner. */
export function claimRuntimeToolLifecycle(
  method: Method,
  executionId: string,
): RuntimeToolLifecycle {
  const owner = context.active().getValue(ownerKey) as Owner | undefined;
  if (
    boundaryConfig().disabled ||
    !owner?.active ||
    owner.claimed ||
    owner.span !== trace.getActiveSpan() ||
    owner.method !== method ||
    owner.executionId !== executionId
  )
    return new RuntimeToolLifecycle();
  owner.claimed = true;
  return new RuntimeToolLifecycle(owner);
}

class RuntimeToolLifecycle {
  public constructor(private readonly owner?: Owner) {}

  private get span(): Span | undefined {
    return this.owner?.active && this.owner.span.isRecording() && !boundaryConfig().disabled
      ? this.owner.span
      : undefined;
  }

  public ready(): void {
    this.span?.addEvent("antnest.mcp.discovery.ready");
  }

  public dispatch(): void {
    this.span?.addEvent("antnest.mcp.tool.dispatch.started");
  }

  public parsed(isError = false): void {
    const outcome = isError ? "tool_error" : "success";
    this.span?.setAttribute("antnest.mcp.tool_result.outcome", outcome);
    this.span?.addEvent("antnest.mcp.tool.result.parsed", { outcome });
  }

  public async close(
    signal: AbortSignal,
    close: () => Promise<void>,
    report: (error: unknown) => void,
  ): Promise<void> {
    const span = this.span;
    span?.addEvent("antnest.mcp.connection.close.started", {
      "antnest.mcp.caller_cancelled": signal.aborted,
    });
    try {
      await close();
      span?.setAttribute("antnest.mcp.connection.close.outcome", "closed");
      span?.addEvent("antnest.mcp.connection.close.completed", { outcome: "closed" });
    } catch (error) {
      span?.setAttribute("antnest.mcp.connection.close.outcome", "failed");
      if (span) {
        try {
          recordBoundaryError(span, error, "mcp.tools.close");
        } catch {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.addEvent("antnest.error", {
            "antnest.error.stage": "mcp.tools.close",
            "antnest.error.type": "uninspectable_error",
          });
        }
      }
      span?.addEvent("antnest.mcp.connection.close.completed", { outcome: "failed" });
      try {
        report(error);
      } catch {
        // A diagnostic sink must not replace the parsed result or dispatch error.
      }
    }
  }
}

export type { RuntimeToolLifecycle };
