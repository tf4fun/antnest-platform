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

export function bridgeChatTrace(index = 1) {
  const trace = chatTrace(index);
  const root = trace.spans[0],
    forward = trace.spans[1],
    prompt = trace.spans[2];
  root.operationName = "HTTP POST /api/app/workspace/v1/{path...}";
  root.tags = [
    { key: "span.kind", value: "server" },
    { key: "http.route", value: "/api/app/workspace/v1/{path...}" },
  ];
  forward.operationName = "HTTP POST agent-ui";
  forward.tags = [{ key: "span.kind", value: "client" }];
  trace.processes["agent-ui"] = { serviceName: "agent-ui" };
  for (const [id, parent, service, name] of [
    ["bridge", "forward", "agent-ui", "agent_ui.http.request"],
    ["acp-http", "bridge", "agent-acp-service", "HTTP POST /v1/acp"],
  ])
    trace.spans.push({
      ...structuredClone(root),
      spanID: id,
      processID: service,
      operationName: name,
      tags: [{ key: "span.kind", value: "server" }],
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent },
      ],
    });
  prompt.references[0].spanID = "acp-http";
  prompt.tags.push({ key: "antnest.agent.id", value: agentId });
  trace.spans
    .find((span) => span.spanID === "run")
    .tags.push({ key: "antnest.run.id", value: `run-${index}` });
  return trace;
}

export function executionState() {
  return {
    agent_id: agentId,
    availability: "ready",
    active_session_id: null,
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    unavailable_reason: null,
  };
}
