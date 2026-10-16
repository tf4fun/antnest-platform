import { addRunInformationRead } from "../observability/runtime-information-run-fixtures.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";

export function privateHTTPRejectionFixture(
  rejection = "session_access_denied",
  { method = "session/load", sameSpan = false } = {},
) {
  const f = privateHTTPFixture("request", { method, sameSpan });
  const code = rejection === "access_denied" ? rejection : undefined;
  const message = code
    ? "Agent access was denied"
    : "DomainError: unregistered message omitted";
  const operation = `acp.session.${method === "session/load" ? "resume" : method.split("/")[1]}`;
  f.expected.rejection = rejection;
  f.expected.rejectionReceipt = {
    rpcCode: -32020,
    code: rejection,
    retryable: false,
  };
  if (method === "session/new") {
    delete f.expected.sessionId;
    f.set(f.request, "antnest.session.id", undefined);
  } else if (method === "session/fork") {
    f.expected.sessionId = f.expected.inputSessionID;
    f.set(f.request, "antnest.session.id", f.expected.sessionId);
  }
  const application = f.add(
    "f".repeat(16),
    f.request.spanID,
    operation,
    undefined,
    3,
    {
      "span.kind": "internal",
      "antnest.agent.id": f.expected.agentId,
      ...(f.expected.inputSessionID
        ? { "antnest.session.id": f.expected.inputSessionID }
        : {}),
      "antnest.outcome": "rejected",
      "antnest.operation.phase": operation,
      "error.type": "DomainError",
      ...(code ? { "error.code": code, "antnest.error.code": code } : {}),
    },
  );
  f.request.duration = Math.max(
    f.request.duration,
    application.startTime + application.duration - f.request.startTime,
  );
  application.logs = [
    {
      timestamp: application.startTime,
      fields: Object.entries({
        event: "antnest.error",
        "antnest.error.stage": operation,
        "antnest.operation.phase": operation,
        "antnest.error.type": "DomainError",
        ...(code ? { "antnest.error.code": code } : {}),
        "antnest.error.message": message,
        "antnest.error.cause_types": "[]",
        "antnest.error.causes": JSON.stringify([
          { type: "DomainError", ...(code ? { code } : {}), message },
        ]),
      }).map(([key, value]) => ({ key, value })),
    },
  ];
  for (const [key, value] of Object.entries({
    "error.type": "RequestError",
    "antnest.outcome": "rejected",
    "antnest.operation.phase": "acp.dispatch",
    "error.code": "-32020",
    "antnest.error.code": "-32020",
    "rpc.response.status_code": -32020,
    "antnest.error.origin_trace_id": f.trace.traceID,
    "antnest.error.origin_span_id": application.spanID,
  }))
    f.set(f.request, key, value);
  return { ...f, application };
}

// A private HTTP exchange has its own exported POST CLIENT and direct workspace
// receiver. The asynchronous RPC may be a child or reuse that receiver Span.
export function privateHTTPFixture(
  kind = "command",
  { sameSpan = false, method } = {},
) {
  const f = fixture(kind);
  const { trace, expected } = f;
  const add = (...args) => {
    const resources = { ...trace.processes };
    const span = f.add(...args);
    Object.assign(trace.processes, resources);
    return span;
  };
  trace.traceID = "c".repeat(32);
  trace.spans = trace.spans.filter(
    (span) => trace.processes[span.processID].serviceName !== "edge-gateway",
  );
  delete trace.processes["edge-gateway"];
  for (const span of trace.spans) {
    span.traceID = trace.traceID;
    for (const ref of span.references) ref.traceID = trace.traceID;
    for (const log of span.logs ?? [])
      for (const field of log.fields ?? [])
        if (field.key === "trace_id") field.value = trace.traceID;
  }
  for (const item of f.requests ?? []) item.trace_id = trace.traceID;
  const set = (span, key, value) => {
    span.tags = span.tags.filter((item) => item.key !== key);
    if (value !== undefined) span.tags.push({ key, value });
  };
  const request = trace.spans.find((span) => span.spanID === "request");
  expected.method = method ?? expected.method;
  request.operationName = `acp ${expected.method}`;
  if (expected.method === "initialize") expected.sessionId = undefined;
  if (expected.method === "session/fork") expected.sessionId = "forked-session";
  const inputSessionID = ["initialize", "session/new"].includes(expected.method)
    ? null
    : "session";
  for (const [key, value] of Object.entries({
    "rpc.method": expected.method,
    "rpc.system.name": "jsonrpc",
    "rpc.service": "acp",
    "antnest.protocol.version": "v1",
    "antnest.session.id": expected.sessionId,
  }))
    set(request, key, value);
  trace.processes["agent-acp-service"].tags = Object.entries({
    "host.name": "acp-host",
    "process.pid": 17,
    "service.instance.id": "acp-instance",
  }).map(([key, value]) => ({ key, value }));
  const client = add(
    "1".repeat(16),
    null,
    "HTTP POST agent-acp-workspace",
    "antnest-private-acp-client",
    0,
    {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": expected.method === "initialize" ? 200 : 202,
      "http.response.body.size": 0,
      "antnest.outcome": "eof",
      "antnest.http.body.outcome": "eof",
    },
  );
  let receiver;
  if (sameSpan) receiver = request;
  else {
    receiver = add(
      "receiver",
      client.spanID,
      "HTTP POST /v1/acp",
      undefined,
      1,
    );
    request.references = [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: receiver.spanID },
    ];
    request.duration = 20; // RPC completion legitimately outlives its 202 ACK.
  }
  receiver.operationName = "HTTP POST /v1/acp";
  receiver.references = [
    { refType: "CHILD_OF", traceID: trace.traceID, spanID: client.spanID },
  ];
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/v1/acp",
    "antnest.listener": "workspace",
    "http.response.status_code": expected.method === "initialize" ? 200 : 202,
  }))
    set(receiver, key, value);
  const receipt = (index, httpMethod, id, extra = {}) => ({
    index,
    method: httpMethod,
    connectionID: "actual-connection",
    sessionID: null,
    status: httpMethod === "GET" ? 200 : 202,
    bodyOutcome: "eof",
    bytes: 0,
    failed: false,
    wireStarted: true,
    started: { unixMs: 1000, monotonicMs: 1 },
    ended: { unixMs: 2000, monotonicMs: 1001 },
    events: [],
    traceID: id.repeat(32),
    clientSpanID: "1".repeat(16),
    ...extra,
  });
  const initialize = receipt(0, "POST", "a", {
    connectionID: null,
    responseConnectionID: "actual-connection",
    rpcMethod: "initialize",
    requestID: 0,
    rpcSessionID: null,
    status: 200,
  });
  const post =
    expected.method === "initialize"
      ? { ...initialize, traceID: trace.traceID, requestID: 2 }
      : receipt(2, "POST", "c", {
          rpcMethod: expected.method,
          requestID: 2,
          rpcSessionID: inputSessionID,
        });
  const requests = [
    expected.method === "initialize" ? post : initialize,
    receipt(1, "GET", "b", { bodyOutcome: "cancelled" }),
    ...(expected.method === "initialize" ? [] : [post]),
    receipt(3, "DELETE", "d"),
  ];
  delete expected.connectionTraceID;
  Object.assign(expected, {
    boundary: "private-acp",
    protocolVersion: 1,
    transport: "http",
    traceID: trace.traceID,
    clientSpanID: client.spanID,
    inputSessionID,
    httpRequestIndex: post.index,
    connectionID: post.connectionID,
    httpConnection: {
      initialized: true,
      closing: true,
      streamJoined: true,
      pendingRequests: 0,
      failures: [],
      requests,
    },
  });
  return { ...f, add, request, client, receiver, post, set };
}

export function fixture(kind = "command", http = false) {
  const f = requestFixture(
    kind === "request" ? "session/load" : "session/prompt",
  );
  Object.assign(f.expected, {
    kind,
    requestId: "2",
    transport: http ? "http" : "websocket",
  });
  const request = f.trace.spans[2];
  request.tags.push({ key: "antnest.request.id", value: "2" });
  if (http) {
    f.expected.traceID = f.trace.traceID;
    f.trace.spans[0].references = [];
    f.trace.spans[1].operationName = "HTTP POST agent-acp-workspace";
    f.trace.spans[1].tags = [
      { key: "span.kind", value: "client" },
      { key: "http.request.method", value: "POST" },
      { key: "server.address", value: "agent-acp-workspace" },
    ];
    f.trace.spans[0].tags = [
      { key: "span.kind", value: "server" },
      { key: "http.request.method", value: "POST" },
      { key: "http.route", value: "/api/app/agents/{agent_id}/v1/acp" },
    ];
    f.add("http-server", "forward", "HTTP POST /v1/acp", undefined, 2, {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/v1/acp",
    });
    request.references[0].spanID = "http-server";
  }
  if (kind !== "request") {
    f.add("run", "request", "agent.run", undefined, 3, {
      "antnest.run.id": "run",
    });
    f.add("transaction", "run", "postgresql transaction", undefined, 4, {
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    });
    f.add("write", "transaction", "INSERT", undefined, 4, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": "INSERT",
    });
  }
  if (kind === "ordinary") {
    f.expected.phase = "v1-baseline";
    for (const [id, name] of [
      ["info", "mcp.runtime.info"],
      ["list", "mcp.tools.list"],
    ]) {
      f.add(id, "run", name, undefined, 5);
      f.add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
    }
    f.requests = ["tool", "reply"].map((stage, index) => {
      f.add(
        `model-${index}`,
        "run",
        "model.complete",
        undefined,
        10 + index * 10,
      );
      f.add(
        `model-http-${index}`,
        `model-${index}`,
        "HTTP POST model",
        undefined,
        10 + index * 10,
        { "span.kind": "client" },
      );
      return {
        phase: "v1-baseline",
        stage,
        trace_id: f.trace.traceID,
        model_span_id: `model-http-${index}`,
      };
    });
    f.add("call", "run", "mcp.tools.call", undefined, 15, {
      "antnest.run.id": "run",
      "tool.name": "bash",
    });
    f.add("tool-http", "call", "HTTP POST antnest-runtime", undefined, 15, {
      "span.kind": "client",
    });
    f.add("tool-server", "tool-http", "HTTP POST /mcp", "antnest-runtime", 15, {
      "span.kind": "server",
      "rpc.method": "tools/call",
    });
    f.add("tool", "tool-server", "runtime.mcp.tool", "antnest-runtime", 15);
  }
  if (kind === "ordinary") f.information = addRunInformationRead(f.trace);
  return f;
}
