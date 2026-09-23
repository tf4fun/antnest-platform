import { stepsFor, caseFor } from "./model.mjs";

export function requestFixture(
  method = "session/load",
  connection = "connection",
) {
  const trace = { traceID: `trace-${connection}`, processes: {}, spans: [] };
  const expected = {
    method,
    sessionId: "session",
    agentId: "agent",
    connectionTraceID: connection,
  };
  const add = (
    id,
    parent,
    name,
    service = "agent-acp-service",
    time = 10,
    tags = {},
  ) => {
    trace.processes[service] = { serviceName: service };
    const span = {
      spanID: id,
      traceID: trace.traceID,
      operationName: name,
      processID: service,
      startTime: time,
      duration: 1,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
    };
    trace.spans.push(span);
    return span;
  };
  add("root", null, `acp ${method}`, "edge-gateway", 0, {
    "rpc.method": method,
    "span.kind": "server",
  }).references.push({
    refType: "FOLLOWS_FROM",
    traceID: connection,
    spanID: "socket",
  });
  add("forward", "root", `acp ${method}`, "edge-gateway", 1, {
    "span.kind": "producer",
    "antnest.operation.phase": "forward",
  });
  add("request", "forward", `acp ${method}`, "agent-acp-service", 2, {
    "span.kind": "server",
    "rpc.method": method,
    "antnest.session.id": "session",
    "antnest.agent.id": "agent",
  });
  return { trace, expected, add };
}
export function executionFixture(phase = "v1-execute") {
  const fixture = requestFixture("session/prompt");
  const { trace, add, expected } = fixture;
  expected.phase = phase;
  add("run", "request", "agent.run", undefined, 3, { "antnest.run.id": "run" });
  add("transaction", "run", "postgresql transaction", undefined, 4, {
    "db.system.name": "postgresql",
    "antnest.transaction.outcome": "committed",
  });
  add("insert", "transaction", "INSERT", undefined, 4, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "INSERT",
  });
  for (const [id, name] of [
    ["info", "mcp.runtime.info"],
    ["list", "mcp.tools.list"],
  ]) {
    add(id, "run", name, undefined, 5);
    add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
  }
  const requests = Array.from(
    { length: stepsFor(phase).length + 1 },
    (_, stage) => {
      add(
        `model-${stage}`,
        "run",
        "model.complete",
        undefined,
        10 + stage * 10,
      );
      add(
        `http-${stage}`,
        `model-${stage}`,
        "HTTP POST model",
        undefined,
        10 + stage * 10,
        { "span.kind": "client" },
      );
      return {
        phase,
        stage,
        trace_id: trace.traceID,
        model_span_id: `http-${stage}`,
      };
    },
  );
  if (caseFor(phase).remote) {
    add("call", "run", "mcp.tools.call", undefined, 15, {
      "antnest.run.id": "run",
      "tool.name": "write",
    });
    add("call-http", "call", "HTTP POST antnest-runtime", undefined, 15, {
      "span.kind": "client",
    });
    add("server", "call-http", "HTTP POST /mcp", "antnest-runtime", 15, {
      "span.kind": "server",
      "rpc.method": "tools/call",
    });
    add("tool", "server", "runtime.mcp.tool", "antnest-runtime", 15);
  }
  return { ...fixture, requests };
}
