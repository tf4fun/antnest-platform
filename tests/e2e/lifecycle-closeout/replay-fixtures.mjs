export function readonlyReplayFixture() {
  const traceID = "b".repeat(32);
  const expected = { traceID, agentID: "agent_test" };
  const trace = { traceID, spans: [], processes: {} };
  const add = (id, service, name, parent, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID,
      spanID: id,
      processID: service,
      operationName: name,
      startTime: 1,
      duration: 1,
      references: parent
        ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  };
  const http = (kind, route) => ({
    "span.kind": kind,
    "http.request.method": "POST",
    "http.response.status_code": 202,
    ...(route ? { "http.route": route } : {}),
  });
  add(
    "gateway",
    "edge-gateway",
    "POST /api/admin/{path...}",
    null,
    http("server", "/api/admin/{path...}"),
  );
  add("gateway-client", "edge-gateway", "HTTP POST", "gateway", http("client"));
  add(
    "console",
    "admin-console",
    "POST /api/admin/agents",
    "gateway-client",
    http("server", "/api/admin/agents"),
  );
  add(
    "console-client",
    "admin-console",
    "HTTP POST",
    "console",
    http("client"),
  );
  add("admit", "agent-controller", "POST /internal/agents", "console-client", {
    ...http("server", "/internal/agents"),
    "antnest.agent.id": expected.agentID,
  });
  add("transaction", "agent-controller", "postgresql transaction", "admit");
  for (const [id, operation, sql] of [
    ["begin", "BEGIN", "begin isolation level repeatable read read only"],
    [
      "select",
      "SELECT",
      "SELECT request_id FROM agent_controller.agent_lifecycle_operations WHERE request_id=$1",
    ],
    ["commit", "COMMIT", "commit"],
  ])
    add(id, "agent-controller", operation, "transaction", {
      "db.operation.name": operation,
      "db.query.text": sql,
    });
  return { trace, expected, add };
}
