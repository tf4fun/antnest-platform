export function addCompletedRead(
  trace,
  root,
  transport = "ws",
  agent = "agent_test",
) {
  const fields = (values) =>
    Object.entries(values).map(([key, value]) => ({ key, value }));
  trace.processes.acp = { serviceName: "agent-acp-service" };
  trace.processes.runtime = { serviceName: "antnest-runtime" };
  root.processID = "acp";
  root.operationName =
    transport === "http" ? "HTTP POST /v1/acp" : "acp initialize";
  root.tags = fields({
    "span.kind": "server",
    ...(transport === "http"
      ? {
          "http.request.method": "POST",
          "http.route": "/v1/acp",
          "http.response.status_code": 200,
        }
      : {}),
    "rpc.method": "initialize",
    "antnest.agent.id": agent,
  });
  const add = (parent, processID, operationName, tags) => {
    const span = {
      traceID: trace.traceID,
      spanID: (trace.spans.length + 256).toString(16).padStart(16, "0"),
      processID,
      operationName,
      startTime: root.startTime + 10,
      duration: 60,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent.spanID },
      ],
      tags: fields(tags),
      logs: [],
    };
    trace.spans.push(span);
    return span;
  };
  const client = add(root, "acp", "HTTP POST antnest-runtime", {
    "span.kind": "client",
    "http.request.method": "POST",
    "http.response.status_code": 200,
    "peer.service": "antnest-runtime",
    "antnest.operation.phase": "http.send_or_read",
    "antnest.outcome": "cancelled",
    "antnest.cancellation.type": "AbortError",
  });
  client.logs = [
    {
      timestamp: root.startTime + 70,
      fields: fields({
        event: "antnest.cancelled",
        "antnest.cancellation.phase": "http.send_or_read",
        "antnest.cancellation.type": "AbortError",
      }),
    },
  ];
  const server = add(client, "runtime", "HTTP POST /mcp", {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/mcp",
    "http.response.status_code": 200,
    "rpc.method": "resources/read",
    "antnest.agent.id": agent,
    "antnest.protocol.outcome": "success",
    "http.transport.outcome": "canceled",
    "http.transport.error.type": "client_disconnected",
  });
  const operation = add(server, "runtime", "runtime.mcp.operation", {
    "rpc.method": "resources/read",
    "antnest.agent.id": agent,
    "otel.status_code": "OK",
    "mcp.operation.outcome": "success",
    "antnest.operation.outcome": "success",
    "error.type": "",
  });
  operation.startTime = root.startTime + 20;
  operation.duration = 20;
  for (const span of [server, operation])
    for (const [key, value] of Object.entries({
      "antnest.runtime.execution.id": "execution_test",
      "antnest.runtime.generation": "1",
    }))
      span.tags.push({ key, value });
  const completion = {
    timestamp: root.startTime + 70,
    fields: fields({
      event: "Runtime HTTP request completed",
      level: "WARN",
      "service.name": "antnest-runtime",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "url.path": "/mcp",
      "antnest.agent.id": agent,
      trace_id: server.traceID,
      span_id: server.spanID,
      "error.type": "client_disconnected",
      "http.transport.outcome": "canceled",
    }),
  };
  const cancelled = {
    timestamp: root.startTime + 60,
    fields: fields({
      event: "antnest.cancelled",
      "antnest.phase": "http",
      "antnest.cancellation.type": "client_disconnected",
      "antnest.protocol.outcome": "success",
    }),
  };
  server.logs = [completion, cancelled];
  return { root, client, server, operation, completion, cancelled };
}
