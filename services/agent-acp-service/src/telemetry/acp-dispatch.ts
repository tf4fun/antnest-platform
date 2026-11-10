import { context, isSpanContextValid, SpanKind, trace } from "@opentelemetry/api";
import { SEMCONV } from "./semconv.gen.js";
import { normalizeAttributes } from "./names.js";
import type { ConnectionBinding } from "../domain/types.js";
import {
  acpMethod,
  boundaryConfig,
  rpcContent,
  record,
  recordBoundaryError,
  safeId,
} from "./diagnostics.js";
import { activeHttpSpan, extractedContext } from "./http.js";

export function createAcpDispatcher(version: "v1" | "v2", binding: ConnectionBinding) {
  const connection = trace.getSpan(context.active())?.spanContext();
  return async <Result>(
    method: string,
    params: unknown,
    requestId: string | number | null | undefined,
    operation: () => Result | Promise<Result>,
  ): Promise<Result> => {
    if (boundaryConfig().disabled) return operation();
    const normalized = acpMethod(method);
    const input = record(params);
    const parent = extractedContext(record(input._meta));
    const http = activeHttpSpan();
    const span =
      http ??
      trace.getTracer("agent-acp-service").startSpan(
        `acp ${normalized}`,
        {
          kind: requestId === undefined ? SpanKind.INTERNAL : SpanKind.SERVER,
          links:
            trace.getSpanContext(parent) === undefined &&
            connection !== undefined &&
            isSpanContextValid(connection)
              ? [{ context: connection }]
              : [],
        },
        parent,
      );
    span.setAttributes(
      normalizeAttributes({
        "rpc.system.name": "jsonrpc",
        "rpc.service": "acp",
        "rpc.method": normalized,
        [SEMCONV.ANTNEST_PROTOCOL_VERSION]: version,
        [SEMCONV.ANTNEST_AGENT_ID]: binding.agentId,
        ...(requestId === undefined || requestId === null
          ? {}
          : { [SEMCONV.ANTNEST_REQUEST_ID]: safeId(String(requestId)) }),
        ...(safeId(input.sessionId) === undefined
          ? {}
          : { [SEMCONV.ANTNEST_SESSION_ID]: safeId(input.sessionId) }),
      }),
    );
    const isRequest = requestId !== undefined;
    return context.with(
      http === undefined ? trace.setSpan(parent, span) : context.active(),
      async () => {
        if (isRequest) rpcContent(span, "request", params);
        try {
          const result = await operation();
          const output = record(result);
          if (safeId(output.sessionId) !== undefined)
            span.setAttributes(
              normalizeAttributes({ [SEMCONV.ANTNEST_SESSION_ID]: safeId(output.sessionId)! }),
            );
          if (isRequest) rpcContent(span, "response", result);
          return result;
        } catch (error) {
          recordBoundaryError(span, error, "acp.dispatch");
          if (isRequest) rpcContent(span, "response", error);
          throw error;
        } finally {
          if (http === undefined) span.end();
        }
      },
    );
  };
}
