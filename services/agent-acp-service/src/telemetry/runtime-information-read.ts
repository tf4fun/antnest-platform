import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { SEMCONV } from "./semconv.gen.js";
import { normalizeAttributes } from "./names.js";
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
    span.addEvent(SEMCONV.ANTNEST_ERROR, {
      [SEMCONV.ANTNEST_ERROR_STAGE]: phase,
      [SEMCONV.ANTNEST_ERROR_TYPE]: "uninspectable_error",
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
    span?.addEvent(SEMCONV.ANTNEST_MCP_DISCOVERY_READY);
    try {
      span?.addEvent(SEMCONV.ANTNEST_MCP_RESOURCE_READ_STARTED);
      const result = await owned.read();
      span?.setAttributes(
        normalizeAttributes({ [SEMCONV.ANTNEST_MCP_RESOURCE_READ_OUTCOME]: "success" }),
      );
      span?.addEvent(SEMCONV.ANTNEST_MCP_RESOURCE_VALIDATED);
      return result;
    } catch (error) {
      recordFailure(span, error, "mcp.runtime.info.read");
      throw error;
    } finally {
      span?.addEvent(SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_STARTED, {
        [SEMCONV.ANTNEST_MCP_CALLER_CANCELLED]: signal.aborted,
      });
      try {
        await owned.close();
        span?.setAttributes(
          normalizeAttributes({ [SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_OUTCOME]: "closed" }),
        );
        span?.addEvent(SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_COMPLETED, { outcome: "closed" });
      } catch (error) {
        span?.setAttributes(
          normalizeAttributes({ [SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_OUTCOME]: "failed" }),
        );
        recordFailure(span, error, "mcp.runtime.info.close");
        span?.addEvent(SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_COMPLETED, { outcome: "failed" });
        reportCloseFailure(error);
      }
    }
  };
  if (boundaryConfig().disabled) return run();
  const admittedExecution = safeId(executionId);
  return trace.getTracer("agent-acp-service").startActiveSpan(
    "mcp.runtime.info.read",
    {
      attributes: normalizeAttributes({
        ...(admittedExecution === undefined
          ? {}
          : { [SEMCONV.ANTNEST_RUNTIME_EXECUTION_ID]: admittedExecution }),
        [SEMCONV.ANTNEST_MCP_RESOURCE_READ_OUTCOME]: "failed",
        [SEMCONV.ANTNEST_MCP_CONNECTION_CLOSE_OUTCOME]: "not_started",
      }),
    },
    async (span) => {
      try {
        return await run(span);
      } finally {
        span.setAttributes(
          normalizeAttributes({ [SEMCONV.ANTNEST_MCP_CALLER_CANCELLED]: signal.aborted }),
        );
        span.end();
      }
    },
  );
}
