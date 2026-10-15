import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";
import { tag } from "./trace-tree.mjs";

export function addRunInformationRead(
  trace,
  { requestSpanId = "request", version = 1, ...options } = {},
) {
  const request = trace.spans.find((span) => span.spanID === requestSpanId);
  const run = trace.spans.find((span) => span.operationName === "agent.run");
  const info = trace.spans.find(
    (span) => span.operationName === "mcp.runtime.info",
  );
  const list = trace.spans.find(
    (span) => span.operationName === "mcp.tools.list",
  );
  const agent = tag(request, "antnest.agent.id") ?? "agent";
  for (const span of trace.spans) {
    span.startTime *= 1000;
    span.duration *= 1000;
  }
  setTag(request, "antnest.agent.id", agent);
  setTag(request, "antnest.protocol.version", `v${version}`);
  setTag(run, "antnest.session.id", tag(request, "antnest.session.id"));
  setTag(run, "antnest.runtime.execution_id", "execution_test");
  info.duration = 100;
  if (list.startTime <= info.startTime + info.duration) {
    list.startTime = info.startTime + 1000;
    trace.spans.find((span) => span.spanID === "list-runtime").startTime =
      list.startTime;
  }
  trace.spans = trace.spans.filter((span) => span.spanID !== "info-runtime");
  const originalLength = trace.spans.length;
  const read = addCompletedRead(trace, info, "http", agent, {
    preserveRequest: true,
    runtimeOutcome: "success",
    clientOutcome: "success",
    ...options,
  });
  const added = trace.spans.splice(originalLength);
  trace.spans.splice(trace.spans.indexOf(info) + 1, 0, ...added);
  const listServer = trace.spans.find((span) => span.spanID === "list-runtime");
  const listClient = {
    ...structuredClone(list),
    spanID: "list-http",
    operationName: "HTTP POST antnest-runtime",
    references: [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: list.spanID },
    ],
    tags: [],
  };
  trace.spans.splice(trace.spans.indexOf(listServer), 0, listClient);
  listServer.references[0].spanID = listClient.spanID;
  for (const span of trace.spans) {
    const runtime =
      trace.processes[span.processID].serviceName === "antnest-runtime";
    if (runtime && !added.includes(span)) {
      setTag(span, "antnest.agent.id", agent);
      setTag(span, "antnest.runtime.execution.id", "execution_test");
    }
    if (span.operationName === "HTTP POST antnest-runtime") {
      setTag(span, "span.kind", "client");
      setTag(span, "peer.service", "antnest-runtime");
      setTag(span, "http.request.method", "POST");
      setTag(span, "http.response.status_code", 200);
    }
    if (
      runtime &&
      span.operationName === "HTTP POST /mcp" &&
      !added.includes(span)
    ) {
      setTag(span, "span.kind", "server");
      setTag(span, "http.request.method", "POST");
      setTag(span, "http.response.status_code", 200);
      setTag(span, "http.route", "/mcp");
      if (span === listServer) setTag(span, "rpc.method", "tools/list");
    }
  }
  for (const owner of trace.spans.filter((span) =>
    ["mcp.tools.list", "mcp.tools.call"].includes(span.operationName),
  )) {
    const client = trace.spans.find(
      (span) =>
        span.operationName === "HTTP POST antnest-runtime" &&
        span.references[0]?.spanID === owner.spanID,
    );
    const server = trace.spans.find(
      (span) => span.references[0]?.spanID === client.spanID,
    );
    const discoveryClient = {
      ...structuredClone(client),
      spanID: owner.spanID + "-discovery-http",
      startTime: owner.startTime,
      duration: 200,
    };
    const discoveryServer = {
      ...structuredClone(server),
      spanID: owner.spanID + "-discovery-runtime",
      startTime: server.startTime - 1000,
      duration: 100,
      references: [
        {
          refType: "CHILD_OF",
          traceID: trace.traceID,
          spanID: discoveryClient.spanID,
        },
      ],
    };
    setTag(discoveryServer, "rpc.method", "discover");
    client.startTime = owner.startTime + 300;
    owner.duration = client.startTime + client.duration - owner.startTime + 100;
    trace.spans.splice(
      trace.spans.indexOf(client),
      0,
      discoveryClient,
      discoveryServer,
    );
    addToolLifecycleReceipt(trace, owner);
  }
  run.duration =
    Math.max(...trace.spans.map((span) => span.startTime + span.duration)) -
    run.startTime +
    1000;
  request.duration = run.startTime + run.duration - request.startTime + 2000;
  return { ...read, request, run, info, list };
}

// Synthetic consumer evidence only; never add receipts to an archived trace.
export function addToolLifecycleReceipt(
  trace,
  owner,
  { heldDiscovery = false, cancelledClients = [], cancelledServers = [] } = {},
) {
  const fields = (values) =>
    Object.entries(values).map(([key, value]) => ({ key, value }));
  const event = (timestamp, name, values = {}) => ({
    timestamp,
    fields: fields({ event: name, ...values }),
  });
  const children = (span) =>
    trace.spans.filter((item) => item.references[0]?.spanID === span.spanID);
  const method =
    owner.operationName === "mcp.tools.list" ? "tools/list" : "tools/call";
  const clients = children(owner).filter(
    (span) => span.operationName === "HTTP POST antnest-runtime",
  );
  const pairs = clients.map((client) => ({
    client,
    server: children(client)[0],
  }));
  const invocation = pairs.find(
    ({ server }) => tag(server, "rpc.method") === method,
  );
  const start = owner.startTime;
  const parsedAt =
    invocation.client.startTime + invocation.client.duration - 100;
  const closeAt = parsedAt + 20;
  const closedAt = start + owner.duration - 20;
  for (const [key, value] of Object.entries({
    "span.kind": "internal",
    "antnest.runtime.execution.id": "execution_test",
    "antnest.mcp.method": method,
    "antnest.mcp.tool_result.outcome": "success",
    "antnest.mcp.connection.close.outcome": "closed",
    "antnest.mcp.caller_cancelled": false,
    "antnest.outcome": "ok",
  }))
    setTag(owner, key, value);
  owner.logs = [
    event(start + 250, "antnest.mcp.discovery.ready"),
    event(start + 280, "antnest.mcp.tool.dispatch.started"),
    event(parsedAt, "antnest.mcp.tool.result.parsed", { outcome: "success" }),
    event(closeAt, "antnest.mcp.connection.close.started", {
      "antnest.mcp.caller_cancelled": false,
    }),
    event(closedAt, "antnest.mcp.connection.close.completed", {
      outcome: "closed",
    }),
  ];
  for (const { client, server } of pairs) {
    const rpc = tag(server, "rpc.method");
    const bytes = rpc === "discover" ? 128 : 256;
    for (const [span, pid] of [
      [client, 2],
      [server, 3],
    ]) {
      const process = trace.processes[span.processID];
      process.tags ??= [];
      for (const [key, value] of Object.entries({
        ...(pid === 2
          ? {
              "host.name": process.serviceName + "-host",
              "process.pid": pid,
              "service.instance.id": process.serviceName + "-instance",
            }
          : {
              "antnest.agent.id": tag(server, "antnest.agent.id"),
              "antnest.runtime.generation": "1",
            }),
        "telemetry.sdk.name": "opentelemetry",
        "telemetry.sdk.language": pid === 2 ? "nodejs" : "rust",
      }))
        if (!process.tags.some((item) => item.key === key))
          process.tags.push({ key, value });
    }
    if (rpc === "discover" && heldDiscovery)
      client.duration = parsedAt - client.startTime - 10;
    setTag(client, "http.response.body.size", bytes);
    client.logs = [];
    if (cancelledClients.includes(rpc)) {
      client.duration = closedAt - client.startTime - 5;
      for (const [key, value] of Object.entries({
        "antnest.outcome": "cancelled",
        "antnest.operation.phase": "http.send_or_read",
        "antnest.cancellation.type": "AbortError",
      }))
        setTag(client, key, value);
      client.logs = [
        event(closeAt + 5, "antnest.cancelled", {
          "antnest.cancellation.phase": "http.send_or_read",
          "antnest.cancellation.type": "AbortError",
        }),
      ];
    }
    for (const [key, value] of Object.entries({
      "antnest.runtime.generation": "1",
      "antnest.protocol.outcome": "success",
      "http.transport.outcome": "success",
      "http.response.body.size": bytes,
    }))
      setTag(server, key, value);
    let operation = children(server).find(
      (span) => span.operationName === "runtime.mcp.operation",
    );
    if (!operation) {
      const work = children(server);
      operation = {
        ...structuredClone(server),
        spanID: server.spanID + "-operation",
        operationName: "runtime.mcp.operation",
        startTime: server.startTime + 5,
        duration: server.duration - 10,
        tags: [],
        references: [
          {
            refType: "CHILD_OF",
            traceID: trace.traceID,
            spanID: server.spanID,
          },
        ],
      };
      trace.spans.splice(trace.spans.indexOf(server) + 1, 0, operation);
      for (const child of work) {
        child.references[0].spanID = operation.spanID;
        child.startTime = operation.startTime + 1;
        child.duration = operation.duration - 2;
      }
    }
    for (const [key, value] of Object.entries({
      "span.kind": "internal",
      "rpc.method": rpc,
      "antnest.agent.id": tag(server, "antnest.agent.id"),
      "antnest.runtime.execution.id": "execution_test",
      "antnest.runtime.generation": "1",
      "mcp.operation.outcome": "success",
      "antnest.operation.outcome": "success",
      "otel.status_code": "OK",
    }))
      setTag(operation, key, value);
    operation.logs = [
      event(
        operation.startTime + operation.duration - 1,
        "Runtime MCP operation completed",
        {
          level: "INFO",
          "service.name": "antnest-runtime",
          trace_id: trace.traceID,
          span_id: operation.spanID,
          "antnest.agent.id": tag(server, "antnest.agent.id"),
          "antnest.runtime.generation": "1",
          "mcp.operation.name": rpc,
          "mcp.operation.outcome": "success",
          "error.type": "",
        },
      ),
    ];
    const cancelled = cancelledServers.includes(rpc);
    if (cancelled) {
      setTag(server, "http.transport.outcome", "canceled");
      setTag(server, "http.transport.error.type", "client_disconnected");
    }
    server.logs = [
      ...(cancelled
        ? [
            event(server.startTime + server.duration - 2, "antnest.cancelled", {
              "antnest.phase": "http",
              "antnest.cancellation.type": "client_disconnected",
              "antnest.protocol.outcome": "success",
            }),
          ]
        : []),
      event(
        server.startTime + server.duration - 1,
        "Runtime HTTP request completed",
        {
          level: cancelled ? "WARN" : "INFO",
          "service.name": "antnest-runtime",
          "http.request.method": "POST",
          "url.path": "/mcp",
          "http.response.status_code": 200,
          "antnest.agent.id": tag(server, "antnest.agent.id"),
          "antnest.runtime.generation": "1",
          trace_id: trace.traceID,
          span_id: server.spanID,
          "error.type": cancelled ? "client_disconnected" : "",
          "http.transport.outcome": cancelled ? "canceled" : "success",
        },
      ),
    ];
  }
  return { owner, pairs, events: owner.logs };
}

export function addPostPromptInformationRead(trace, options = {}) {
  const request = trace.spans.find(
    (span) =>
      tag(span, "rpc.method") === "session/prompt" &&
      trace.processes[span.processID].serviceName === "agent-acp-service",
  );
  const run = trace.spans.find((span) => span.operationName === "agent.run");
  const before = trace.spans.length;
  const proof = addCompletedRead(
    trace,
    request,
    "http",
    tag(request, "antnest.agent.id"),
    {
      preserveRequest: true,
      runtimeOutcome: "success",
      clientOutcome: "success",
      ...options,
    },
  );
  const delta = run.startTime + run.duration + 1000 - proof.read.startTime;
  for (const span of trace.spans.slice(before)) {
    span.startTime += delta;
    for (const event of span.logs ?? []) event.timestamp += delta;
  }
  request.duration =
    proof.read.startTime + proof.read.duration - request.startTime + 1000;
  return proof;
}
