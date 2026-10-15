import { addRunInformationRead } from "../observability/runtime-information-run-fixtures.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";

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
