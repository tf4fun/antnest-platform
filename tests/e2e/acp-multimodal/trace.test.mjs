import assert from "node:assert/strict";
import test from "node:test";
import { inspectNativeTrace } from "./trace.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";

function fixture(failed = false, version = 1, http = false) {
  const f = requestFixture("session/prompt");
  const { add, expected, trace } = f;
  Object.assign(expected, {
    kind: failed ? "local-failure" : "native",
    version,
    phase: `v${version}-${http ? "http" : "ws"} ${failed ? "mismatch" : "native"}`,
    requestId: "3",
    transport: http ? "http" : "websocket",
  });
  trace.spans[2].tags.push({ key: "antnest.request.id", value: "3" });
  if (http) {
    expected.traceID = trace.traceID;
    trace.spans[0].references = [];
    trace.spans[1].operationName = "HTTP POST agent-acp-workspace";
    trace.spans[1].tags = [
      { key: "span.kind", value: "client" },
      { key: "http.request.method", value: "POST" },
      { key: "server.address", value: "agent-acp-workspace" },
    ];
    trace.spans[0].tags = [
      { key: "span.kind", value: "server" },
      { key: "http.request.method", value: "POST" },
      { key: "http.route", value: "/api/app/agents/{agent_id}/v1/acp" },
    ];
    add("http-server", "forward", "HTTP POST /v1/acp", undefined, 2, {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/v1/acp",
    });
    trace.spans[2].references[0].spanID = "http-server";
  }
  add("run", "request", "agent.run", undefined, 3, {
    "antnest.run.id": "run",
    "run.terminal_class": failed ? "failed" : "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": "none",
    ...(failed
      ? {
          "antnest.outcome": "failed",
          "otel.status_code": "ERROR",
          "error.type": "run_failed",
        }
      : {}),
  });
  add("finish", "run", "SELECT", undefined, 30, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.query.text":
      "WITH finished AS (UPDATE runs SET state = $2, terminal_class = $2 RETURNING id) SELECT id FROM finished",
  });
  if (!failed) {
    add("transaction", "run", "postgresql transaction", undefined, 20, {
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    });
    add("insert", "transaction", "INSERT", undefined, 20, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": "INSERT",
    });
  }
  for (const [id, name] of [
    ["info", "mcp.runtime.info"],
    ["list", "mcp.tools.list"],
  ]) {
    add(id, "run", name, undefined, 5);
    add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
  }
  add("model", "run", "model.complete", undefined, 10, {
    "model.purpose": "response",
    ...(failed
      ? {
          "antnest.outcome": "error",
          "antnest.error.code": "model_unsupported_content",
          "error.type": "ModelError",
          "otel.status_code": "ERROR",
        }
      : {}),
  });
  f.requests = [];
  if (!failed) {
    add("model-http", "model", "HTTP POST model", undefined, 10, {
      "span.kind": "client",
    });
    f.requests.push({
      phase: expected.phase,
      trace_id: trace.traceID,
      model_span_id: "model-http",
    });
  } else if (version === 1)
    trace.spans[2].tags.push(
      ...Object.entries({
        "antnest.outcome": "error",
        "antnest.error.code": "-32022",
        "rpc.response.status_code": -32022,
        "otel.status_code": "ERROR",
      }).map(([key, value]) => ({ key, value })),
    );
  return f;
}
const inspect = (f) =>
  inspectNativeTrace(f.trace, f.expected, ["PRIVATE"], f.requests);
test("native requests and local model mismatches require current durable Run closure across transports", () => {
  for (const [version, http] of [
    [1, false],
    [2, false],
    [1, true],
  ])
    for (const failed of [false, true]) {
      const f = fixture(failed, version, http),
        result = inspect(f);
      assert.equal(result.provider_requests, failed ? 0 : 1);
      assert.equal(result.local_failures, failed ? 1 : 0);
      f.trace.spans[0].warnings = ["clock skew adjustment disabled"];
      assert.equal(inspect(f).strict_trace, "failed");
    }
});
test("native trace evidence rejects retired ownership, missing persistence, uncorrelated model and Tool execution", () => {
  for (const mutate of [
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "finish");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "finish").tags.at(-1).value =
        "SELECT 1";
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "insert");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "run").tags[1].value = "failed";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "run").tags[3].value = "unknown";
    },
    (f) => {
      f.requests[0].model_span_id = "model";
    },
    (f) => {
      f.requests[0].phase = "foreign";
    },
    (f) => {
      f.expected.requestId = "wrong";
    },
    (f) => {
      f.expected.sessionId = "wrong";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "list-runtime").references = [];
    },
    (f) => {
      f.add("tool", "run", "runtime.mcp.tool", "antnest-runtime");
    },
    (f) => {
      f.add("tool-server", "run", "HTTP POST /mcp", "antnest-runtime", 10, {
        "rpc.method": "tools/call",
      });
    },
    (f) => {
      f.add("admit", "run", "agent_controller.acquire_run", "agent-controller");
    },
    (f) => {
      f.add("leak", "run", "op", undefined, 10, { body: "PRIVATE" });
    },
    (f) => {
      f.trace.spans[0].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ];
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  }
});
test("local capability failure never permits HTTP, missing diagnostics, or unrelated errors", () => {
  for (const version of [1, 2])
    for (const mutate of [
      (f) => {
        f.add("http", "model", "HTTP POST model", undefined, 10, {
          "span.kind": "client",
        });
      },
      (f) => {
        f.trace.spans
          .find((s) => s.spanID === "model")
          .tags.find((t) => t.key === "antnest.error.code").value =
          "model_unavailable";
      },
      (f) => {
        f.trace.spans.find((s) => s.spanID === "model").tags = [
          { key: "model.purpose", value: "response" },
        ];
      },
      (f) => {
        f.add("db-error", "run", "SELECT", undefined, 10, { error: true });
      },
      (f) => {
        f.trace.spans
          .find((s) => s.spanID === "list-runtime")
          .tags.push({ key: "error", value: true });
      },
    ]) {
      const f = fixture(true, version);
      mutate(f);
      assert.throws(() => inspect(f));
    }
  const f = fixture(true, 2);
  f.trace.spans[2].tags.push({ key: "error", value: true });
  assert.throws(() => inspect(f));
});

test("model-to-closure timestamp inversion remains a strict failure with raw evidence", () => {
  const f = fixture(true, 2);
  f.trace.spans.find((span) => span.spanID === "finish").startTime = 10;
  const result = inspect(f);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.model_finish_order, "failed");
  assert.equal(result.model_to_finish_gap_us, -1);
  assert.deepEqual(result.model_finish_timing, {
    model_start_us: 10,
    model_duration_us: 1,
    finish_start_us: 10,
  });
});
