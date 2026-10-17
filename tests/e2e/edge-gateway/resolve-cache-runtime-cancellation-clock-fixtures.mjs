export const fields = (object) =>
  Object.entries(object).map(([key, value]) => ({ key, value }));
export const set = (span, key, value) => {
  span.tags = span.tags.filter((item) => item.key !== key);
  if (value !== undefined) span.tags.push({ key, value });
};
export const end = (span) => span.startTime + span.duration;

export function runtimeCancellationClockFixture(runtimeOffset = 70000) {
  const base = 1000000000;
  const acp = {
    serviceName: "agent-acp-service",
    tags: fields({
      "host.name": "acp",
      "process.pid": 1,
      "service.instance.id": "acp:1",
    }),
  };
  const runtime = {
    serviceName: "antnest-runtime",
    tags: fields({
      "antnest.agent.id": "agent",
      "antnest.runtime.generation": "1",
      "antnest.runtime.image.id": "sha256:image",
    }),
  };
  const trace = {
    traceID: "a".repeat(32),
    spans: [],
    processes: { acp, runtime },
  };
  const cancelTrace = {
    traceID: "b".repeat(32),
    spans: [],
    processes: { other: structuredClone(acp) },
  };
  const add = (
    id,
    parent,
    name,
    start,
    finish,
    tags = {},
    processID = "acp",
    target = trace,
  ) => {
    const span = {
      traceID: target.traceID,
      spanID: id,
      processID,
      operationName: name,
      startTime: base + start + (processID === "runtime" ? runtimeOffset : 0),
      duration: finish - start,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: target.traceID, spanID: parent }]
        : [],
      tags: fields(tags),
      logs: [],
    };
    target.spans.push(span);
    return span;
  };
  const binding = {
    "antnest.agent.id": "agent",
    "antnest.runtime.execution.id": "execution",
    "antnest.runtime.generation": "1",
  };
  const prompt = add("prompt", null, "acp session/prompt", 0, 4200000, {
    "span.kind": "server",
    "rpc.method": "session/prompt",
    "antnest.agent.id": "agent",
    "antnest.session.id": "session",
  });
  const run = add("run", "prompt", "agent.run", 50000, 4055000, {
    "antnest.run.id": "run",
    "antnest.session.id": "session",
  });
  const model = add("model", "run", "model.complete", 100000, 105000);
  const tool = add("bash", "run", "mcp.tools.call", 200000, 4020000, {
    "tool.name": "bash",
    "antnest.run.id": "run",
  });
  const client = add(
    "client",
    "bash",
    "HTTP POST antnest-runtime",
    210000,
    4015000,
    {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    },
  );
  const server = add(
    "server",
    "client",
    "HTTP POST /mcp",
    212000,
    4022000,
    {
      ...binding,
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/mcp",
      "rpc.method": "tools/call",
    },
    "runtime",
  );
  const operation = add(
    "operation",
    "server",
    "runtime.mcp.operation",
    212100,
    4021900,
    { ...binding, "rpc.method": "tools/call", "mcp.tool.name": "bash" },
    "runtime",
  );
  const runtimeTool = add(
    "runtime-tool",
    "operation",
    "runtime.mcp.tool",
    212200,
    4021800,
    { "mcp.tool.name": "bash" },
    "runtime",
  );
  const executor = add(
    "executor",
    "runtime-tool",
    "runtime.executor",
    212300,
    4021700,
    { "executor.tool.name": "bash" },
    "runtime",
  );
  const finish = add("finish", "run", "SELECT", 4040000, 4050000, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.query.text":
      "WITH finished AS (UPDATE runs SET state = $1) SELECT * FROM finished",
  });
  const ack = add(
    "ack",
    null,
    "HTTP POST /v1/acp",
    3999000,
    4001000,
    {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.response.status_code": 202,
    },
    "other",
    cancelTrace,
  );
  const cancel = add(
    "cancel",
    "ack",
    "acp session/cancel",
    4000000,
    4100000,
    {
      "span.kind": "internal",
      "rpc.method": "session/cancel",
      "antnest.agent.id": "agent",
      "antnest.session.id": "session",
    },
    "other",
    cancelTrace,
  );
  function calibration(id, start, parent = "run") {
    const c = add(
      id + "-client",
      parent,
      "HTTP POST antnest-runtime",
      start,
      start + 1000,
      {
        "span.kind": "client",
        "http.request.method": "POST",
        "http.response.status_code": 200,
        "http.response.body.size": 42,
      },
    );
    const s = add(
      id + "-server",
      c.spanID,
      "HTTP POST /mcp",
      start + 200,
      start + 500,
      {
        ...binding,
        "span.kind": "server",
        "http.request.method": "POST",
        "http.route": "/mcp",
        "rpc.method": "discover",
        "http.response.status_code": "200",
        "http.response.body.size": 42,
        "antnest.protocol.outcome": "success",
        "http.transport.outcome": "success",
      },
      "runtime",
    );
    const o = add(
      id + "-operation",
      s.spanID,
      "runtime.mcp.operation",
      start + 250,
      start + 450,
      {
        ...binding,
        "rpc.method": "discover",
        "mcp.operation.name": "discover",
        "mcp.operation.outcome": "success",
        "antnest.operation.outcome": "success",
        "otel.status_code": "OK",
        "error.type": "",
      },
      "runtime",
    );
    const common = {
      "antnest.agent.id": "agent",
      "antnest.runtime.generation": "1",
      "service.name": "antnest-runtime",
      trace_id: trace.traceID,
      level: "INFO",
      "error.type": "",
    };
    s.logs = [
      {
        timestamp: end(s),
        fields: fields({
          ...common,
          span_id: s.spanID,
          event: "Runtime HTTP request completed",
          "http.request.method": "POST",
          "url.path": "/mcp",
          "http.response.status_code": "200",
          "http.transport.outcome": "success",
        }),
      },
    ];
    o.logs = [
      {
        timestamp: end(o),
        fields: fields({
          ...common,
          span_id: o.spanID,
          event: "Runtime MCP operation completed",
          "mcp.operation.name": "discover",
          "mcp.operation.outcome": "success",
        }),
      },
    ];
    return { client: c, server: s, operation: o };
  }
  const first = calibration("first", 80000);
  const second = calibration("second", 207000, "bash");
  const after = calibration("after", 4150000, "prompt");
  const expected = {
    cancelTrace,
    cancelSpanID: cancel.spanID,
    promptSpanID: prompt.spanID,
    runSpanID: run.spanID,
    modelSpanID: model.spanID,
    toolSpanID: tool.spanID,
    finishSpanID: finish.spanID,
    runtimeSpanID: server.spanID,
    runtimeExecutionID: "execution",
    runtimeGeneration: "1",
  };
  return {
    trace,
    cancelTrace,
    expected,
    prompt,
    run,
    model,
    tool,
    client,
    server,
    operation,
    runtimeTool,
    executor,
    finish,
    ack,
    cancel,
    first,
    second,
    after,
    calibration,
  };
}
