// Keep diagnostic metadata separate from errors: never retain raw transport causes.
const metadata = new WeakMap();
const names = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "AssertionError",
  "AggregateError",
  "TimeoutError",
  "AbortError",
]);
const codes = new Set([
  "ERR_ASSERTION",
  "ABORT_ERR",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const allowed = {
  stage: new Set(["agent-cleanup", "business-and-agent-cleanup"]),
  request_phase: new Set([
    "fetch",
    "response-body",
    "http-status",
    "json-parse",
  ]),
  cleanup_phase: new Set(["delete-request", "operation-poll"]),
  reason: new Set([
    "operation-failed",
    "operation-timeout",
    "operation-response-invalid",
    "delete-response-invalid",
  ]),
  transport_error_type: names,
  transport_code: codes,
  operation_kind: new Set(["create", "rebuild", "disable", "enable", "delete"]),
  operation_phase: new Set([
    "drain",
    "network_ensure",
    "network_fence",
    "runtime_initialize",
    "runtime_update",
    "runtime_disable",
    "runtime_enable",
    "runtime_delete",
    "network_release",
    "network_restore",
    "publish",
    "completed",
  ]),
  operation_state: new Set(["running", "completed", "failed"]),
};
const ranges = {
  http_status: [100, 599],
  expected_status: [100, 599],
  agent_index: [0, Number.MAX_SAFE_INTEGER],
  timeout_ms: [1, 3600000],
};

export function annotateFailure(error, fields) {
  if (!(error instanceof Error)) error = new Error("Fixture failed");
  const safe = { ...metadata.get(error) };
  for (const [key, value] of Object.entries(fields)) {
    const range = ranges[key];
    if (
      allowed[key]?.has(value) ||
      (range &&
        Number.isSafeInteger(value) &&
        value >= range[0] &&
        value <= range[1])
    )
      safe[key] = value;
  }
  metadata.set(error, safe);
  return error;
}

export function transportFailure(error) {
  const result = {
    transport_error_type: names.has(error?.name) ? error.name : "Error",
  };
  // Undici commonly wraps its network code in TypeError.cause. Copy only the code.
  for (
    let current = error, depth = 0;
    current && depth < 3;
    current = current.cause, depth++
  ) {
    if (codes.has(current.code)) {
      result.transport_code = current.code;
      break;
    }
  }
  return result;
}

export function summarizeFailure(error) {
  const seen = new Set();
  function visit(value, depth) {
    const result = {
      error_type: names.has(value?.name) ? value.name : "Error",
      ...(codes.has(value?.code) ? { code: value.code } : {}),
      ...metadata.get(value),
    };
    if (value instanceof AggregateError) {
      if (depth >= 3 || seen.has(value)) return { ...result, truncated: true };
      seen.add(value);
      result.errors = value.errors
        .slice(0, 8)
        .map((child) => visit(child, depth + 1));
      if (value.errors.length > 8) result.truncated = true;
      seen.delete(value);
    }
    return result;
  }
  return visit(error, 0);
}
