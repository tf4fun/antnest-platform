import { requestFixture } from "../acp-plan/trace-fixture.mjs";

export function managedRequestFixture(phase = "managed-fresh") {
  const plan =
    phase === "managed-exercise"
      ? ["mcp__alpha__fail", "mcp__alpha__echo", "bash"]
      : ["mcp__alpha__echo"];
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    kind: "managed",
    transport: "websocket",
    requestId: "42",
    phase,
    snapshot: {
      execution_revision: "exec",
      runtime_revision: "runtime",
      runtime_execution_id: "child",
    },
  });
  f.trace.spans[2].tags.push({ key: "antnest.request.id", value: "42" });
  f.add("run", "request", "agent.run", undefined, 3, {
    "antnest.run.id": "run",
  });
  f.add(
    "finish",
    "run",
    "SELECT",
    undefined,
    phase === "managed-exercise" ? 90 : 70,
    {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.query.text":
        "WITH finished AS (UPDATE runs SET state = $1) SELECT * FROM finished",
    },
  );
  for (const [id, name] of [
    ["info", "mcp.runtime.info"],
    ["list", "mcp.tools.list"],
  ]) {
    f.add(id, "run", name, undefined, 5);
    f.add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
  }
  f.requests = Array.from({ length: plan.length + 1 }, (_, i) => i).map(
    (step) => {
      f.add(
        `model-${step}`,
        "run",
        "model.complete",
        undefined,
        10 + step * 20,
        {
          "antnest.execution.revision": "exec",
          "antnest.runtime.revision": "runtime",
          "antnest.runtime.execution_id": "child",
          "antnest.agent.revision": "spec",
          "antnest.configuration.revision": 3,
        },
      );
      f.add(
        `http-${step}`,
        `model-${step}`,
        "HTTP POST model",
        undefined,
        10 + step * 20,
        { "span.kind": "client" },
      );
      return {
        phase,
        step,
        trace_id: f.trace.traceID,
        model_span_id: `http-${step}`,
        outcome: "validated",
      };
    },
  );
  for (const [i, name] of plan.entries()) {
    const suffix = i ? `-${i}` : "";
    f.add(`call${suffix}`, "run", "mcp.tools.call", undefined, 20 + i * 20, {
      "antnest.run.id": "run",
      "tool.name": name,
    });
    f.add(
      `client${suffix}`,
      `call${suffix}`,
      "HTTP POST antnest-runtime",
      undefined,
      20 + i * 20,
      { "span.kind": "client" },
    );
    f.add(
      `server${suffix}`,
      `client${suffix}`,
      "HTTP POST /mcp",
      "antnest-runtime",
      20 + i * 20,
      { "span.kind": "server", "rpc.method": "tools/call" },
    );
    f.add(
      `tool${suffix}`,
      `server${suffix}`,
      "runtime.mcp.tool",
      "antnest-runtime",
      20 + i * 20,
    );
    if (name.startsWith("mcp__"))
      f.add(
        `stdio${suffix}`,
        `tool${suffix}`,
        "runtime.mcp.stdio",
        "antnest-runtime",
        20 + i * 20,
        {
          "span.kind": "client",
          "rpc.method": "tools/call",
          "mcp.tool.name": name,
        },
      );
    if (name.endsWith("__fail")) {
      for (const id of [`call${suffix}`, `tool${suffix}`, `stdio${suffix}`])
        f.trace.spans
          .find((s) => s.spanID === id)
          .tags.push(
            { key: "otel.status_code", value: "ERROR" },
            {
              key: "error.type",
              value: id.startsWith("call")
                ? "mcp_tool_error"
                : "managed_tool_error",
            },
          );
    }
  }
  return f;
}
