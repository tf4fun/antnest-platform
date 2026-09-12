import { context, isSpanContextValid, SpanKind, trace } from "@opentelemetry/api";
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
    span.setAttributes({
      "rpc.system.name": "jsonrpc",
      "rpc.service": "acp",
      "rpc.method": normalized,
      "antnest.protocol.version": version,
      "antnest.agent.id": binding.agentId,
      ...(requestId === undefined || requestId === null
        ? {}
        : { "antnest.request.id": safeId(String(requestId)) }),
      ...(safeId(input.sessionId) === undefined
        ? {}
        : { "antnest.session.id": safeId(input.sessionId) }),
    });
    const isRequest = requestId !== undefined;
    return context.with(
      http === undefined ? trace.setSpan(parent, span) : context.active(),
      async () => {
        if (isRequest) rpcContent(span, "request", params);
        try {
          const result = await operation();
          const output = record(result);
          if (safeId(output.sessionId) !== undefined)
            span.setAttribute("antnest.session.id", safeId(output.sessionId)!);
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
