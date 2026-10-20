import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shutdownPrivateTraceFixture } from "./shutdown-private-trace.fixture.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
const url = new URL("./shutdown-private-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f) => {
  assert.equal(
    typeof implementation.inspectShutdownPrivateWatchTrace,
    "function",
  );
  return implementation.inspectShutdownPrivateWatchTrace(
    f.trace,
    f.expected,
    [],
  );
};
test("private Shutdown binds the original body, exported CLIENT and normal ACP process shutdown without rewriting strict errors", () => {
  const f = shutdownPrivateTraceFixture(),
    original = structuredClone(f);
  const result = inspect(f);
  assert.equal(result.remote_closure_verified, true);
  assert.equal(result.stop_window_verified, true);
  assert.equal(result.error_spans, 1);
  assert.equal(result.database_spans, 2);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.owned_error_spans[0].span_id, f.server.spanID);
  assert.equal(
    implementation.shutdownPrivateWatchOutcome([result]).accepted,
    true,
  );
  assert.deepEqual(f, original);
});
for (const [name, mutate] of [
  ["missing actual CLIENT", (f) => f.trace.spans.shift()],
  [
    "wrong exported CLIENT",
    (f) => {
      f.expected.clientSpanID = "0".repeat(16);
    },
  ],
  [
    "wrong parent",
    (f) => {
      f.server.references[0].spanID = f.sql.spanID;
    },
  ],
  [
    "duplicate SERVER",
    (f) => f.trace.spans.push({ ...f.server, spanID: "9".repeat(16) }),
  ],
  ["wrong route", (f) => setTag(f.server, "http.route", "/v1/acp")],
  ["wrong method", (f) => setTag(f.server, "http.request.method", "GET")],
  ["wrong listener", (f) => setTag(f.server, "antnest.listener", "control")],
  [
    "foreign organization",
    (f) => setTag(f.server, "antnest.organization.id", "foreign"),
  ],
  [
    "unknown shutdown Error",
    (f) => setTag(f.server, "antnest.stream.termination", undefined),
  ],
  [
    "AbortError substitute",
    (f) => setTag(f.server, "error.type", "AbortError"),
  ],
  ["extra error code", (f) => setTag(f.server, "error.code", "unavailable")],
  [
    "extra exception",
    (f) => setTag(f.server, "exception.message", "internal failure"),
  ],
  [
    "duplicate error event",
    (f) => f.server.logs.push(structuredClone(f.server.logs[0])),
  ],
  [
    "late error event",
    (f) => {
      f.server.logs[0].timestamp = 9000000;
    },
  ],
  [
    "missing original cause",
    (f) => {
      f.server.logs[0].fields = f.server.logs[0].fields.filter(
        (x) => x.key !== "antnest.error.causes",
      );
    },
  ],
  [
    "duplicate diagnostic field",
    (f) => f.server.tags.push({ key: "error.type", value: "Error" }),
  ],
  [
    "wrong process hostname",
    (f) => setTag(f.trace.processes.acp, "host.name", "foreign"),
  ],
  [
    "wrong namespace PID",
    (f) => setTag(f.trace.processes.acp, "process.pid", 2),
  ],
  [
    "wrong instance",
    (f) => setTag(f.trace.processes.acp, "service.instance.id", "foreign"),
  ],
  [
    "replacement container",
    (f) => {
      f.expected.stop.after.find((x) => x.name === "agent-acp-service").id =
        "foreign";
    },
  ],
  [
    "forced process exit",
    (f) => {
      f.expected.stop.after.find((x) => x.name === "agent-acp-service").exit =
        137;
    },
  ],
  [
    "ACP outlives its process",
    (f) => {
      f.server.duration += 3000;
    },
  ],
  [
    "wrong closure owner",
    (f) => {
      f.receipt.closure.clientSpanID = "f".repeat(16);
    },
  ],
  [
    "local closure",
    (f) => {
      f.receipt.closure.kind = "local-close";
    },
  ],
  [
    "closure before stop",
    (f) => {
      f.receipt.closure.observedAt = 1999;
    },
  ],
  [
    "changed clock tolerance",
    (f) => {
      f.expected.stopWindow.end++;
    },
  ],
  [
    "unjoined response",
    (f) => {
      f.receipt.joined = false;
    },
  ],
  ["read failure", (f) => f.receipt.errors.push("original read error")],
  [
    "fake EOF",
    (f) => {
      f.receipt.body_outcome = "failed";
    },
  ],
  [
    "raw bytes changed",
    (f) => {
      f.receipt.body_bytes++;
    },
  ],
  [
    "state snapshot changed",
    (f) => {
      f.receipt.events[0].agent_id = "foreign";
    },
  ],
  [
    "only terminal frame",
    (f) => {
      const raw = Buffer.from(
        `event: workspace_error\ndata: ${JSON.stringify(f.receipt.terminal_events[0])}\n\n`,
      );
      f.receipt.raw_body_base64 = raw.toString("base64");
      f.receipt.body_bytes = raw.length;
    },
  ],
  [
    "CLIENT body count mismatch",
    (f) => setTag(f.client, "http.response.body.size", 0),
  ],
  ["unowned SQL failure", (f) => setTag(f.sql, "error", true)],
  ["readiness error", (f) => setTag(f.readiness, "error", true)],
  [
    "readiness connection string capture",
    (f) => setTag(f.readiness, "db.connection_string", "postgres://capture"),
  ],
  [
    "readiness parameter capture",
    (f) =>
      f.readiness.logs.push({
        fields: [{ key: "db.query.parameters.value", value: "captured" }],
      }),
  ],
  [
    "different readiness wrapper",
    (f) => {
      f.readiness.operationName = "postgres.unregistered";
    },
  ],
  [
    "readiness under CLIENT",
    (f) => {
      f.readiness.references[0].spanID = f.client.spanID;
    },
  ],
  [
    "missing readiness query",
    (f) => {
      f.trace.spans = f.trace.spans.filter((span) => span !== f.readinessSQL);
    },
  ],
  [
    "foreign service dependency",
    (f) => {
      f.trace.processes.acp.serviceName = "agent-controller";
    },
  ],
  [
    "RPC payload capture",
    (f) =>
      f.sql.logs.push({
        fields: [{ key: "antnest.payload.json", value: "captured" }],
      }),
  ],
])
  test(`private Shutdown rejects ${name}`, () => {
    assert.equal(
      typeof implementation.inspectShutdownPrivateWatchTrace,
      "function",
    );
    const f = shutdownPrivateTraceFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });
test("private Shutdown keeps optional terminal and response Trace headers without inventing them", () => {
  const f = shutdownPrivateTraceFixture();
  f.receipt.terminal_events = [];
  const raw = Buffer.from(
    `event: workspace_state\ndata: ${JSON.stringify(f.receipt.events[0])}\n\n`,
  );
  f.receipt.raw_body_base64 = raw.toString("base64");
  f.receipt.body_bytes = raw.length;
  setTag(f.client, "http.response.body.size", raw.length);
  assert.equal(inspect(f).remote_closure_verified, true);
  f.receipt.response_trace_id = "f".repeat(32);
  assert.throws(() => inspect(f));
});
test("private Shutdown only accepts its exact raw diagnostic ownership and existing clock warnings", () => {
  const result = inspect(shutdownPrivateTraceFixture());
  for (const change of [
    (r) => (r.owned_error_spans[0].reason = "blanket-shutdown"),
    (r) =>
      r.raw_error_inventory.push({ trace_id: "foreign", span_id: "foreign" }),
    (r) => {
      r.warnings = ["unknown internal warning"];
      r.warning_count = 1;
    },
  ]) {
    const value = structuredClone(result);
    change(value);
    assert.equal(
      implementation.shutdownPrivateWatchOutcome([value]).accepted,
      false,
    );
  }
});
test("private Shutdown collector flushes CLIENT and requires three complete stable snapshots including late warnings", async (t) => {
  assert.equal(
    typeof implementation.collectShutdownPrivateWatchTrace,
    "function",
  );
  const f = shutdownPrivateTraceFixture(),
    directory = mkdtempSync(join(tmpdir(), "shutdown-private-trace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0,
    flushed = false;
  const result = await implementation.collectShutdownPrivateWatchTrace(
    "http://jaeger",
    f.expected,
    {
      secrets: [],
      directory,
      attempts: 6,
      wait: async () => {},
      flush: async () => {
        flushed = true;
      },
      request: async (address) => {
        assert(flushed);
        assert.equal(
          new URL(address).pathname,
          "/api/traces/" + f.trace.traceID,
        );
        calls++;
        if (calls === 3)
          f.sql.warnings = [
            "clock skew adjustment disabled; not applying calculated delta of 1ms",
          ];
        return Response.json({ data: [f.trace] });
      },
    },
  );
  assert.equal(calls, 5);
  assert.equal(result.warning_count, 1);
  assert.equal(
    implementation.shutdownPrivateWatchOutcome([result]).accepted,
    true,
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(directory, f.trace.traceID + ".json"), "utf8"),
    ),
    f.trace,
  );
});
