import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { boundaryConfig, recordBoundaryError, safeId } from "./diagnostics.js";

type OwnedRead<Result> = {
  read(): Promise<Result>;
  close(): Promise<void>;
};

function recordFailure(span: Span | undefined, error: unknown, phase: string): void {
  if (!span) return;
  try {
    recordBoundaryError(span, error, phase);
  } catch {
    // Unknown errors may have throwing accessors. Diagnostics must not replace
    // the original read result or prevent its connection from being closed.
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.addEvent("antnest.error", {
      "antnest.error.stage": phase,
      "antnest.error.type": "uninspectable_error",
    });
  }
}

/** Observes the adapter's parsed result and its own connection cleanup, never the resource body. */
export function observeRuntimeInformationRead<Result>(
  executionId: string,
  signal: AbortSignal,
  connect: () => Promise<OwnedRead<Result>>,
  reportCloseFailure: (error: unknown) => void,
): Promise<Result> {
  const run = async (span?: Span): Promise<Result> => {
    let owned: OwnedRead<Result>;
    try {
      owned = await connect();
    } catch (error) {
      recordFailure(span, error, "mcp.runtime.info.connect");
      throw error;
    }
    span?.addEvent("antnest.mcp.discovery.ready");
    try {
      span?.addEvent("antnest.mcp.resource.read.started");
      const result = await owned.read();
      span?.setAttribute("antnest.mcp.resource_read.outcome", "success");
      span?.addEvent("antnest.mcp.resource.validated");
      return result;
    } catch (error) {
      recordFailure(span, error, "mcp.runtime.info.read");
      throw error;
    } finally {
      span?.addEvent("antnest.mcp.connection.close.started", {
        "antnest.mcp.caller_cancelled": signal.aborted,
      });
      try {
        await owned.close();
        span?.setAttribute("antnest.mcp.connection.close.outcome", "closed");
        span?.addEvent("antnest.mcp.connection.close.completed", { outcome: "closed" });
      } catch (error) {
        span?.setAttribute("antnest.mcp.connection.close.outcome", "failed");
        recordFailure(span, error, "mcp.runtime.info.close");
        span?.addEvent("antnest.mcp.connection.close.completed", { outcome: "failed" });
        reportCloseFailure(error);
      }
    }
  };
  if (boundaryConfig().disabled) return run();
  const admittedExecution = safeId(executionId);
  return trace.getTracer("agent-acp-service").startActiveSpan(
    "mcp.runtime.info.read",
    {
      attributes: {
        ...(admittedExecution === undefined
          ? {}
          : { "antnest.runtime.execution.id": admittedExecution }),
        "antnest.mcp.resource_read.outcome": "failed",
        "antnest.mcp.connection.close.outcome": "not_started",
      },
    },
    async (span) => {
      try {
        return await run(span);
      } finally {
        span.setAttribute("antnest.mcp.caller_cancelled", signal.aborted);
        span.end();
      }
    },
  );
}
