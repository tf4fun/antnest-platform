export const route = "/api/admin/{path...}";
export const expected = {
  traceID: "a".repeat(32),
  route,
  console: true,
  controllerRoute: "/internal/agents/{agent_id}/events/watch",
  stopWindow: { start: 1000, end: 3000 },
};
export function traceFixture() {
  const span = (id, service, parent, extra = []) => ({
    spanID: id,
    traceID: expected.traceID,
    processID: service,
    startTime: 1000000,
    duration: 10,
    references: parent
      ? [{ refType: "CHILD_OF", traceID: expected.traceID, spanID: parent }]
      : [],
    tags: [
      { key: "span.kind", value: "server" },
      { key: "http.response.status_code", value: 200 },
      ...extra,
    ],
  });
  return {
    traceID: expected.traceID,
    processes: Object.fromEntries(
      [
        "edge-gateway",
        "identity-service",
        "admin-console",
        "agent-controller",
      ].map((s) => [s, { serviceName: s }]),
    ),
    spans: [
      span("edge", "edge-gateway", null, [
        { key: "http.route", value: route },
        { key: "http.request.method", value: "GET" },
      ]),
      span("identity", "identity-service", "edge"),
      span("console", "admin-console", "edge"),
      span("controller", "agent-controller", "console", [
        { key: "http.route", value: expected.controllerRoute },
      ]),
    ],
  };
}

export function cancelledTrace() {
  const trace = traceFixture();
  trace.spans[0].tags.push(
    { key: "error", value: true },
    { key: "otel.status_description", value: "handler_aborted" },
    { key: "antnest.http.request_cancelled", value: true },
  );
  return trace;
}

export function dependencyCancellationFixture(executionState = false) {
  const trace = traceFixture();
  const server = (id, service, parent, route, method = "GET") => ({
    spanID: id,
    traceID: trace.traceID,
    processID: service,
    operationName: `HTTP ${method} ${route}`,
    startTime: 1000000,
    duration: 20,
    references: parent
      ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
      : [],
    tags: Object.entries({
      "span.kind": "server",
      "http.route": route,
      "http.request.method": method,
      "http.response.status_code": 200,
    }).map(([key, value]) => ({ key, value })),
  });
  const client = (id, parent, peer, method = "GET") => ({
    ...server(
      id,
      parent === "edge" ? "edge-gateway" : "admin-console",
      parent,
      `unused`,
      method,
    ),
    operationName: `HTTP ${method} ${peer}`,
    tags: Object.entries({
      "span.kind": "client",
      "http.request.method": method,
      "http.response.status_code": 200,
      "error.type": "cancelled",
      error: true,
    }).map(([key, value]) => ({ key, value })),
  });
  if (executionState) {
    trace.processes["agent-acp-service"] = { serviceName: "agent-acp-service" };
    trace.spans = [
      trace.spans[0],
      trace.spans[1],
      client("forward", "edge", "agent-acp-workspace", "POST"),
      server(
        "acp",
        "agent-acp-service",
        "forward",
        "/rpc/agent-acp/watch-agent-execution-state",
        "POST",
      ),
    ];
    trace.spans
      .at(-1)
      .tags.push(
        { key: "rpc.method", value: "watch_agent_execution_state" },
        { key: "error.type", value: "stream_interrupted" },
        { key: "otel.status_code", value: "ERROR" },
      );
  } else {
    trace.spans = [
      trace.spans[0],
      trace.spans[1],
      client("forward", "edge", "admin-console"),
      server(
        "console",
        "admin-console",
        "forward",
        "/api/admin/agents/{agent_id}/events/watch",
      ),
      client("console-forward", "console", "agent-controller"),
      server(
        "controller",
        "agent-controller",
        "console-forward",
        expected.controllerRoute,
      ),
    ];
    trace.spans[3].tags.push({ key: "error.type", value: "cancelled" });
    trace.spans[3].logs = [
      {
        fields: [
          { key: "event", value: "antnest.error" },
          { key: "error.type", value: "cancelled" },
        ],
      },
    ];
    trace.spans[5].tags.push(
      { key: "error.type", value: "canceled" },
      { key: "otel.status_code", value: "ERROR" },
      { key: "otel.status_description", value: "request_failed" },
    );
  }
  return {
    trace,
    want: { ...expected, console: !executionState, executionState },
  };
}
