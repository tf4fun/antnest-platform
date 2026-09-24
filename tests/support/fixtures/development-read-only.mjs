export const agentId = "agent_" + "a".repeat(32);
export const sessionId = "11111111-2222-4333-8444-555555555555";

export function chatTrace(index = 1, rejection = false) {
  const traceID = index.toString(16).padStart(32, "0");
  const trace = { traceID, spans: [], processes: {} };
  function add(id, parent, service, name, fields = {}) {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID,
      spanID: id,
      processID: service,
      operationName: name,
      startTime: 1000000,
      duration: 100,
      references: parent
        ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
        : [],
      tags: Object.entries(fields).map(([key, value]) => ({ key, value })),
    });
  }
  add("gateway", null, "edge-gateway", "acp session/prompt", {
    "rpc.method": "session/prompt",
    "span.kind": "server",
  });
  add("forward", "gateway", "edge-gateway", "acp session/prompt", {
    "span.kind": "producer",
    "antnest.operation.phase": "forward",
  });
  add("prompt", "forward", "agent-acp-service", "acp session/prompt", {
    "rpc.method": "session/prompt",
    "span.kind": "server",
    "antnest.session.id": sessionId,
    ...(rejection
      ? { "antnest.error.class": "model_unsupported_content" }
      : {}),
  });
  if (!rejection) {
    add("run", "prompt", "agent-acp-service", "agent.run");
    add("model", "run", "agent-acp-service", "HTTP POST model", {
      "span.kind": "client",
    });
    add("mcp", "run", "agent-acp-service", "HTTP POST antnest-runtime", {
      "span.kind": "client",
    });
    add("runtime", "mcp", "antnest-runtime", "tools/call", {
      "span.kind": "server",
      "rpc.method": "tools/call",
    });
  }
  return trace;
}

export function managedAgent() {
  return {
    agent_id: agentId,
    lifecycle_state: "active",
    activation_state: "enabled",
    runtime_state: "running",
    active_operation_request_id: null,
    runtime: { runtime_revision: "runtime-revision" },
    executable_execution_revision: "execution-revision",
  };
}

export function executionState() {
  return {
    agent_id: agentId,
    availability: "ready",
    active_session_id: null,
    access_allowed: true,
    configuration_revision: "configuration-revision",
    unavailable_reason: null,
  };
}
