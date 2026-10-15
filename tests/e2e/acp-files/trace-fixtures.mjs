import { addRunInformationRead } from "../observability/runtime-information-run-fixtures.mjs";

export function fixture(method = "session/prompt", sessionId = "session") {
  const trace = { traceID: "trace", processes: {}, spans: [] };
  const add = (id, parent, name, service, time, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      spanID: id,
      traceID: "trace",
      operationName: name,
      processID: service,
      startTime: time,
      duration: 1,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      references: parent
        ? [{ refType: "CHILD_OF", traceID: "trace", spanID: parent }]
        : [],
    });
  };
  add("root", null, `acp ${method}`, "edge-gateway", 0, {
    "rpc.method": method,
    "span.kind": "server",
  });
  trace.spans[0].references.push({
    refType: "FOLLOWS_FROM",
    traceID: "connection",
    spanID: "socket",
  });
  add("forward", "root", `acp ${method}`, "edge-gateway", 1, {
    "span.kind": "producer",
    "antnest.operation.phase": "forward",
  });
  add("prompt", "forward", `acp ${method}`, "agent-acp-service", 2, {
    "rpc.method": method,
    "span.kind": "server",
    "antnest.session.id": sessionId,
  });
  return { trace, add };
}
export function execution(phase = "v1-create") {
  const { trace, add } = fixture();
  add("run", "prompt", "agent.run", "agent-acp-service", 3, {
    "antnest.run.id": "run",
  });
  for (const [id, name, time] of [
    ["info", "mcp.runtime.info", 4],
    ["list", "mcp.tools.list", 6],
  ]) {
    add(id, "run", name, "agent-acp-service", time);
    add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", time);
  }
  add("model", "run", "model.complete", "agent-acp-service", 10);
  add("http", "model", "HTTP POST model", "agent-acp-service", 10, {
    "span.kind": "client",
  });
  add("call", "run", "mcp.tools.call", "agent-acp-service", 12, {
    "antnest.run.id": "run",
  });
  add(
    "call-http",
    "call",
    "HTTP POST antnest-runtime",
    "agent-acp-service",
    12,
    { "span.kind": "client" },
  );
  add("server", "call-http", "HTTP POST /mcp", "antnest-runtime", 13, {
    "rpc.method": "tools/call",
    "span.kind": "server",
  });
  add("tool", "server", "runtime.mcp.tool", "antnest-runtime", 14);
  const information = addRunInformationRead(trace, {
    requestSpanId: "prompt",
    version: Number(phase[1]),
  });
  return {
    trace,
    requests: [{ trace_id: "trace", model_span_id: "http", phase }],
    information,
  };
}
