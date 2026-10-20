export function addCompletedRead(
  trace,
  root,
  transport = "ws",
  agent = "agent_test",
  {
    runtimeOutcome = "canceled",
    clientOutcome = "cancelled",
    preserveRequest = false,
  } = {},
) {
  const fields = (values) =>
    Object.entries(values).map(([key, value]) => ({ key, value }));
  const acpProcess = preserveRequest ? root.processID : "acp";
  const runtimeProcess =
    Object.keys(trace.processes).find(
      (id) => trace.processes[id].serviceName === "antnest-runtime",
    ) ?? "runtime";
  for (const [id, serviceName, pid] of [
    [acpProcess, "agent-acp-service", 2],
    [runtimeProcess, "antnest-runtime", 3],
  ])
    trace.processes[id] ??= {
      serviceName,
      tags: fields({
        "host.name": serviceName + "-host",
        "process.pid": pid,
        "service.instance.id": serviceName + "-instance",
      }),
    };
  if (!preserveRequest) {
    root.processID = acpProcess;
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
  }
  const add = (parent, processID, operationName, start, duration, tags) => {
    const span = {
      traceID: trace.traceID,
      spanID: (trace.spans.length + 256).toString(16).padStart(16, "0"),
      processID,
      operationName,
      startTime: root.startTime + start,
      duration,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent.spanID },
      ],
      tags: fields(tags),
      logs: [],
    };
    trace.spans.push(span);
    return span;
  };
  const event = (at, values) => ({
    timestamp: root.startTime + at,
    fields: fields(values),
  });
  const read = add(root, acpProcess, "mcp.runtime.info.read", 5, 80, {
    "span.kind": "internal",
    "antnest.runtime.execution.id": "execution_test",
    "antnest.mcp.resource_read.outcome": "success",
    "antnest.mcp.connection.close.outcome": "closed",
    "antnest.mcp.caller_cancelled": false,
  });
  const discoveryReady = event(25, { event: "antnest.mcp.discovery.ready" });
  const readStarted = event(29, { event: "antnest.mcp.resource.read.started" });
  const validated = event(60, { event: "antnest.mcp.resource.validated" });
  const closeStarted = event(70, {
    event: "antnest.mcp.connection.close.started",
    "antnest.mcp.caller_cancelled": false,
  });
  const closeCompleted = event(80, {
    event: "antnest.mcp.connection.close.completed",
    outcome: "closed",
  });
  read.logs = [
    discoveryReady,
    readStarted,
    validated,
    closeStarted,
    closeCompleted,
  ];
  const common = {
    "antnest.agent.id": agent,
    "antnest.runtime.execution.id": "execution_test",
    "antnest.runtime.generation": "1",
  };
  const exchange = (method, start, bytes, outcome, cancelledClient) => {
    const client = add(
      read,
      acpProcess,
      "HTTP POST antnest-runtime",
      start,
      method === "discover" ? 10 : cancelledClient ? 45 : 35,
      {
        "span.kind": "client",
        "http.request.method": "POST",
        "http.response.status_code": 200,
        "http.response.body.size": bytes,
        "peer.service": "antnest-runtime",
        ...(cancelledClient
          ? {
              "antnest.operation.phase": "http.send_or_read",
              "antnest.outcome": "cancelled",
              "antnest.cancellation.type": "AbortError",
            }
          : {}),
      },
    );
    if (cancelledClient)
      client.logs = [
        event(74, {
          event: "antnest.cancelled",
          "antnest.cancellation.phase": "http.send_or_read",
          "antnest.cancellation.type": "AbortError",
        }),
      ];
    const server = add(
      client,
      runtimeProcess,
      "HTTP POST /mcp",
      start + 2,
      method === "discover" ? 5 : 33,
      {
        ...common,
        "span.kind": "server",
        "http.request.method": "POST",
        "http.route": "/mcp",
        "http.response.status_code": 200,
        "http.response.body.size": bytes,
        "rpc.method": method,
        "antnest.protocol.outcome": "success",
        "http.transport.outcome": outcome,
        ...(outcome === "canceled"
          ? { "http.transport.error.type": "client_disconnected" }
          : {}),
      },
    );
    const operation = add(
      server,
      runtimeProcess,
      "runtime.mcp.operation",
      start + 3,
      method === "discover" ? 2 : 22,
      {
        ...common,
        "span.kind": "internal",
        "rpc.method": method,
        "otel.status_code": "OK",
        "mcp.operation.outcome": "success",
        "antnest.operation.outcome": "success",
        "error.type": "",
      },
    );
    operation.logs = [
      event(start + (method === "discover" ? 5 : 25), {
        event: "Runtime MCP operation completed",
        level: "INFO",
        "service.name": "antnest-runtime",
        "antnest.agent.id": agent,
        "antnest.runtime.generation": "1",
        trace_id: trace.traceID,
        span_id: operation.spanID,
        "mcp.operation.name": method,
        "mcp.operation.outcome": "success",
        "error.type": "",
      }),
    ];
    const completion = event(start + (method === "discover" ? 7 : 34), {
      event: "Runtime HTTP request completed",
      level: outcome === "canceled" ? "WARN" : "INFO",
      "service.name": "antnest-runtime",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "url.path": "/mcp",
      "antnest.agent.id": agent,
      "antnest.runtime.generation": "1",
      trace_id: server.traceID,
      span_id: server.spanID,
      "error.type": outcome === "canceled" ? "client_disconnected" : "",
      "http.transport.outcome": outcome,
    });
    const cancelled = event(start + 33, {
      event: "antnest.cancelled",
      "antnest.phase": "http",
      "antnest.cancellation.type": "client_disconnected",
      "antnest.protocol.outcome": "success",
    });
    server.logs =
      outcome === "canceled" ? [completion, cancelled] : [completion];
    return { client, server, operation, completion, cancelled };
  };
  const handshake = exchange("discover", 10, 283, "success", false);
  const resource = exchange(
    "resources/read",
    30,
    425,
    runtimeOutcome,
    clientOutcome === "cancelled",
  );
  const executor = add(
    resource.operation,
    runtimeProcess,
    "runtime.executor",
    36,
    14,
    {
      "span.kind": "internal",
      "antnest.agent.id": agent,
      "antnest.runtime.generation": "1",
    },
  );
  executor.logs = [
    event(50, {
      event: "Runtime Executor completed",
      outcome: "success",
      "error.type": "",
      level: "INFO",
      "service.name": "antnest-runtime",
      "antnest.agent.id": agent,
      "antnest.runtime.generation": "1",
      trace_id: trace.traceID,
      span_id: executor.spanID,
    }),
  ];
  return {
    root,
    read,
    discoveryReady,
    readStarted,
    validated,
    closeStarted,
    closeCompleted,
    handshake,
    executor,
    ...resource,
  };
}
