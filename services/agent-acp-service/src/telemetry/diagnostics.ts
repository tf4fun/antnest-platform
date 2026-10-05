import { SpanStatusCode, type Attributes, type Span, type SpanContext } from "@opentelemetry/api";

export type BoundaryConfig = { captureRpcContent: boolean; disabled: boolean };
let configuration: BoundaryConfig = { captureRpcContent: false, disabled: false };
const errorOrigins = new WeakMap<object, SpanContext>();
const methods = new Set([
  "initialize",
  "session/new",
  "session/load",
  "session/list",
  "session/delete",
  "session/fork",
  "session/resume",
  "session/set_config_option",
  "session/set_mode",
  "session/close",
  "session/prompt",
  "session/cancel",
]);

export function configureBoundaries(config: BoundaryConfig): void {
  configuration = { ...config };
}

export function boundaryConfig(): Readonly<BoundaryConfig> {
  return configuration;
}

export function acpMethod(method: string): string {
  return methods.has(method) ? method : "unknown";
}

export function safeId(value: unknown): string | undefined {
  return typeof value === "string" &&
    Buffer.byteLength(value) <= 512 &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/u.test(value)
    ? value
    : undefined;
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function diagnosticEvent(span: Span, name: string, attributes: Attributes): void {
  if (configuration.disabled || !span.isRecording()) return;
  span.addEvent(name, attributes);
}

export function rpcContent(span: Span, direction: "request" | "response", value: unknown): void {
  if (!configuration.captureRpcContent || configuration.disabled || !span.isRecording()) return;
  try {
    const json: unknown = JSON.stringify(value);
    if (typeof json === "string")
      diagnosticEvent(span, `antnest.${direction}`, { "antnest.payload.json": json });
  } catch {
    diagnosticEvent(span, "antnest.capture.error", { "error.type": "json_encoding" });
  }
}

const errorTypes = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "ZodError",
  "DomainError",
  "ModelError",
  "McpError",
  "McpToolCallError",
  "ClientMcpNetworkError",
  "RequestError",
  "WorkerOwnershipLostError",
]);
const errorCodes = new Set<string>([
  "access_denied",
  "audit_not_found",
  "invalid_cursor",
  "execution_audit_unavailable",
  "agent_busy",
  "agent_unavailable",
  "dependency_unavailable",
  "internal_error",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "dependency_failed",
  "model_unsupported_content",
  "model_unavailable",
  "model_http_error",
  "model_invalid_response",
  "provider_endpoint_forbidden",
  "provider_endpoint_unavailable",
  "session_busy",
  "session_not_found",
  "session_closed",
  "service_stopping",
  "invalid_configuration",
  "invalid_execution_configuration",
  "configuration_conflict",
  "configuration_not_ready",
  "agent_operation_conflict",
  "invalid_agent_settlement",
  "runtime_barrier_required",
  "request_too_large",
  "invalid_json",
  "configuration_too_large",
  "method_not_allowed",
  "unsupported_media_type",
  "client_mcp_not_allowed",
  "permission_unavailable",
  "invalid_request",
  "invalid_params",
  "tool_effect_unknown",
]);
const safeMessages: Record<string, string> = {
  ECONNRESET: "Peer reset the connection",
  ECONNREFUSED: "Peer refused the connection",
  ENOTFOUND: "Peer hostname did not resolve",
  ETIMEDOUT: "Network operation exceeded its deadline",
  model_invalid_response: "Model response violated the completion protocol",
  model_http_error: "Model returned an unsuccessful HTTP status",
  model_unavailable: "Model request did not produce a response",
  provider_endpoint_forbidden: "Provider endpoint is forbidden",
  provider_endpoint_unavailable: "Provider endpoint is unavailable",
  session_busy: "Session already has an active Run",
  access_denied: "Agent access was denied",
  invalid_configuration: "Session configuration was rejected",
};

export function safeError(error: unknown): {
  type: string;
  code?: string | number;
  message: string;
} {
  const value = record(error);
  const type = error instanceof Error && errorTypes.has(error.name) ? error.name : "Error";
  const code =
    typeof value.code === "number" &&
    Number.isSafeInteger(value.code) &&
    value.code >= -32768 &&
    value.code <= -32000
      ? value.code
      : typeof value.code === "string" && errorCodes.has(value.code)
        ? value.code
        : undefined;
  return {
    type,
    ...(code === undefined ? {} : { code }),
    message:
      code === undefined
        ? `${type}: unregistered message omitted`
        : (safeMessages[String(code)] ?? `Operation reported ${code}`),
  };
}

export function recordBoundaryError(span: Span, error: unknown, phase: string): void {
  const identity = safeError(error);
  if (identity.type === "AbortError" || identity.code === "ABORT_ERR") {
    span.setAttributes({
      "antnest.operation.phase": phase,
      "antnest.outcome": "cancelled",
      "antnest.cancellation.type": identity.type,
    });
    diagnosticEvent(span, "antnest.cancelled", {
      "antnest.cancellation.phase": phase,
      "antnest.cancellation.type": identity.type,
    });
    return;
  }
  const rejected =
    identity.type === "DomainError" ||
    (typeof identity.code === "number" && [-32600, -32601, -32602, -32020].includes(identity.code));
  span.setAttributes({
    "error.type": identity.type,
    "antnest.operation.phase": phase,
    "antnest.outcome": rejected ? "rejected" : "error",
    ...(identity.code === undefined ? {} : { "antnest.error.code": String(identity.code) }),
    ...(identity.code === undefined ? {} : { "error.code": String(identity.code) }),
    ...(typeof identity.code === "number" ? { "rpc.response.status_code": identity.code } : {}),
  });
  if (!rejected) span.setStatus({ code: SpanStatusCode.ERROR });
  const causes: ReturnType<typeof safeError>[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
    seen.add(current);
    causes.push(safeError(current));
    current = record(current).cause;
  }
  for (const item of seen) {
    if (typeof item !== "object" || item === null) continue;
    const origin = errorOrigins.get(item);
    if (origin !== undefined) {
      span.setAttributes({
        "antnest.error.origin_trace_id": origin.traceId,
        "antnest.error.origin_span_id": origin.spanId,
      });
      return;
    }
  }
  if (span.isRecording()) {
    for (const item of seen) {
      if (typeof item === "object" && item !== null) errorOrigins.set(item, span.spanContext());
    }
  }
  diagnosticEvent(span, "antnest.error", {
    "antnest.error.stage": phase,
    "antnest.error.type": identity.type,
    ...(identity.code === undefined ? {} : { "antnest.error.code": String(identity.code) }),
    "antnest.error.message": identity.message,
    "antnest.error.cause_types": causes.slice(1).map((cause) => cause.type),
    "antnest.error.causes": JSON.stringify(causes),
    "antnest.operation.phase": phase,
  });
}
