export function fixture() {
  const trace = { traceID: "b".repeat(32), spans: [], processes: {} };
  const add = (id, service, name, parent, tags, request, response) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID: trace.traceID,
      spanID: id,
      processID: service,
      operationName: name,
      startTime: 1,
      duration: 1,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      logs: Object.entries({ request, response })
        .filter(([, v]) => v !== undefined)
        .map(([direction, value]) => ({
          fields: [
            { key: "event", value: "antnest." + direction },
            { key: "antnest.payload.json", value: JSON.stringify(value) },
          ],
        })),
    });
  };
  const current = {
    agentID: "agent-test",
    runtimeRevision: "runtime-test",
    runtimeExecutionID: "process-test",
  };
  add(
    "observe",
    "agent-controller",
    "agent_controller.runtime_observation.synchronize",
    null,
    { "span.kind": "consumer" },
  );
  add("client", "agent-controller", "GET", "observe", {
    "span.kind": "client",
    "http.request.method": "GET",
  });
  add(
    "inspect",
    "runtime-controller",
    "GET /internal/runtimes/{agent_id}",
    "client",
    {
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/internal/runtimes/{agent_id}",
      "http.response.status_code": 200,
    },
    undefined,
    {
      agent_id: current.agentID,
      runtime_revision: current.runtimeRevision,
      runtime_execution_id: current.runtimeExecutionID,
      lifecycle_state: "provisioned",
      health: "healthy",
      mcp_endpoint: "http://runtime:8093/mcp",
    },
  );
  add("verify", "runtime-controller", "runtime.status.verify", "inspect", {
    "antnest.agent.id": current.agentID,
    "antnest.runtime.execution_id": current.runtimeExecutionID,
  });
  add("status-client", "runtime-controller", "GET", "verify", {
    "span.kind": "client",
    "http.request.method": "GET",
  });
  add("status", "antnest-runtime", "GET /status", "status-client", {
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "/status",
    "http.response.status_code": 200,
  });
  add("transaction", "agent-controller", "postgresql transaction", "observe", {
    "span.kind": "internal",
  });
  add("execution", "agent-controller", "INSERT", "transaction", {
    "db.query.text":
      "INSERT INTO agent_controller.execution_revisions (id) VALUES ($1)",
  });
  add("commit", "agent-controller", "COMMIT", "transaction", {});
  current.traceID = trace.traceID;
  return { trace, current };
}

export function creationFixture() {
  const agent = {
    agent_id: "agent-test",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
    executable_execution_revision: "execution-test",
    runtime: {
      runtime_revision: "runtime-test",
      runtime_execution_id: "process-test",
      mcp_endpoint: "http://runtime:8093/mcp",
    },
  };
  const operation = { request_id: "request-test", state: "completed" };
  const events = ["agent_create_requested", "agent_created", "agent_ready"].map(
    (event_type, index) => ({
      event_type,
      agent_id: agent.agent_id,
      operation_request_id: operation.request_id,
      global_sequence: index + 1,
      aggregate_sequence: index + 1,
      occurred_at: new Date(index * 1000).toISOString(),
      trace_id: (index === 2 ? "b" : "a").repeat(32),
      data:
        index === 2
          ? {
              execution_revision_id: "execution-test",
              runtime_revision: "runtime-test",
            }
          : {},
    }),
  );
  return { agent, operation, events, creationTraceID: "a".repeat(32) };
}
