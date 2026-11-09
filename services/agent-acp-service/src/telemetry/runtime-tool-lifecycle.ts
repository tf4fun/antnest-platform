import { context, createContextKey, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { SEMCONV } from "./semconv.gen.js";
import { normalizeAttributes } from "./names.js";
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
  span.setAttributes(
    normalizeAttributes({
      [SEMCONV.ANTNEST_RUNTIME_EXECUTION_ID]: admittedExecution,
      [SEMCONV.ANTNEST_MCP_METHOD]: method,
      [SEMCONV.ANTNEST_MCP_TOOL_RESULT_OUTCOME]: "not_received",
      [SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_OUTCOME]: "not_started",
    }),
  );
  try {
    return await context.with(cleared.setValue(ownerKey, owner), operation);
  } finally {
    owner.active = false;
    span.setAttributes(
      normalizeAttributes({ [SEMCONV.ANTNEST_MCP_CALLER_CANCELLED]: signal.aborted }),
    );
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
    this.span?.addEvent(SEMCONV.ANTNEST_MCP_DISCOVERY_READY);
  }

  public dispatch(): void {
    this.span?.addEvent(SEMCONV.ANTNEST_MCP_TOOL_DISPATCH_STARTED);
  }

  public parsed(isError = false): void {
    const outcome = isError ? "tool_error" : "success";
    this.span?.setAttributes(
      normalizeAttributes({ [SEMCONV.ANTNEST_MCP_TOOL_RESULT_OUTCOME]: outcome }),
    );
    this.span?.addEvent(SEMCONV.ANTNEST_MCP_TOOL_RESULT_PARSED, { outcome });
  }

  public async close(
    signal: AbortSignal,
    close: () => Promise<void>,
    report: (error: unknown) => void,
  ): Promise<void> {
    const span = this.span;
    span?.addEvent(SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_STARTED, {
      [SEMCONV.ANTNEST_MCP_CALLER_CANCELLED]: signal.aborted,
    });
    try {
      await close();
      span?.setAttributes(
        normalizeAttributes({ [SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_OUTCOME]: "closed" }),
      );
      span?.addEvent(SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_COMPLETED, { outcome: "closed" });
    } catch (error) {
      span?.setAttributes(
        normalizeAttributes({ [SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_OUTCOME]: "failed" }),
      );
      if (span) {
        try {
          recordBoundaryError(span, error, "mcp.tools.close");
        } catch {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.addEvent(SEMCONV.ANTNEST_ERROR, {
            [SEMCONV.ANTNEST_ERROR_STAGE]: "mcp.tools.close",
            [SEMCONV.ANTNEST_ERROR_TYPE]: "uninspectable_error",
          });
        }
      }
      span?.addEvent(SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_COMPLETED, { outcome: "failed" });
      try {
        report(error);
      } catch {
        // A diagnostic sink must not replace the parsed result or dispatch error.
      }
    }
  }
}

export type { RuntimeToolLifecycle };
