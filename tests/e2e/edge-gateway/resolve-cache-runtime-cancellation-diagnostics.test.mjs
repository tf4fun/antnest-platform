import assert from "node:assert/strict";
import test from "node:test";
import {
  fields,
  set,
  end,
} from "./resolve-cache-runtime-cancellation-clock-fixtures.mjs";
import { runtimeCancellationFixture } from "./resolve-cache-runtime-cancellation-fixtures.mjs";
import { inspectRuntimeCancellationDiagnostics } from "./resolve-cache-runtime-cancellation-diagnostics.mjs";
for (const value of [["200"], "2e2", " 200 "])
  test(`held Runtime cancellation rejects noncanonical status ${JSON.stringify(value)}`, () => {
    const f = runtimeCancellationFixture();
    inspectRuntimeCancellationDiagnostics(f.trace, f.diagnosticsExpected);
    set(f.server, "http.response.status_code", value);
    assert.throws(() =>
      inspectRuntimeCancellationDiagnostics(f.trace, f.diagnosticsExpected),
    );
  });
for (const [key, value] of [
  ["antnest.mcp.method", "tools/call"],
  ["antnest.runtime.execution.id", "execution"],
])
  test(
    "held cancellation rejects incomplete new connection receipt: " + key,
    () => {
      const f = runtimeCancellationFixture();
      inspectRuntimeCancellationDiagnostics(f.trace, f.diagnosticsExpected);
      set(f.tool, key, value);
      assert.throws(() =>
        inspectRuntimeCancellationDiagnostics(f.trace, f.diagnosticsExpected),
      );
    },
  );
const inspect = (f) =>
  inspectRuntimeCancellationDiagnostics(f.trace, f.diagnosticsExpected);
function closedCancellationFixture() {
  const f = runtimeCancellationFixture();
  for (const [key, value] of Object.entries({
    "antnest.runtime.execution.id": "execution",
    "antnest.mcp.method": "tools/call",
    "antnest.mcp.tool_result.outcome": "not_received",
    "antnest.mcp.connection.close.outcome": "closed",
    "antnest.mcp.caller_cancelled": true,
  }))
    set(f.tool, key, value);
  set(f.second.client, "peer.service", "antnest-runtime");
  set(f.second.operation, "span.kind", "internal");
  const event = (timestamp, name, extra = {}) => ({
    timestamp,
    fields: fields({ event: name, ...extra }),
  });
  f.tool.logs.push(
    event(end(f.second.client) + 100, "antnest.mcp.discovery.ready"),
    event(f.client.startTime - 100, "antnest.mcp.tool.dispatch.started"),
    event(end(f.client) - 1000, "antnest.mcp.connection.close.started", {
      "antnest.mcp.caller_cancelled": true,
    }),
    event(end(f.client) + 100, "antnest.mcp.connection.close.completed", {
      outcome: "closed",
    }),
  );
  return f;
}
test("held cancellation validates the original owned connection close and preserves its errors", () => {
  const f = closedCancellationFixture(),
    before = structuredClone(f.trace),
    r = inspect(f);
  assert.equal(r.owned_error_spans.length, 6);
  assert.equal(r.transport_receipts.length, 2);
  assert.equal(r.connection_close.outcome, "closed");
  assert.equal(r.connection_close.parsed_outcome, "not_received");
  assert.deepEqual(f.trace, before);
});
for (const [name, mutate] of [
  [
    "failed close",
    (f) => set(f.tool, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "unstarted close",
    (f) => set(f.tool, "antnest.mcp.connection.close.outcome", "not_started"),
  ],
  [
    "uncancelled caller",
    (f) => set(f.tool, "antnest.mcp.caller_cancelled", false),
  ],
  [
    "parsed result",
    (f) => set(f.tool, "antnest.mcp.tool_result.outcome", "success"),
  ],
  ["missing close event", (f) => f.tool.logs.pop()],
  [
    "duplicate close event",
    (f) => f.tool.logs.push(structuredClone(f.tool.logs.at(-1))),
  ],
  [
    "foreign execution",
    (f) => set(f.tool, "antnest.runtime.execution.id", "other"),
  ],
  [
    "foreign invocation parent",
    (f) => {
      f.client.references[0].spanID = f.run.spanID;
    },
  ],
  [
    "late abort",
    (f) => {
      f.client.logs[0].timestamp = end(f.tool) + 1000;
    },
  ],
  ["unrelated close error", (f) => set(f.tool, "exception.type", "CloseError")],
])
  test("held connection close rejects " + name, () => {
    const f = closedCancellationFixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("held Runtime cancellation retains five ERROR spans and the non-ERROR HTTP error event", () => {
  const f = runtimeCancellationFixture(),
    before = structuredClone(f.trace),
    result = inspect(f);
  assert.equal(result.otel_error_spans.length, 5);
  assert.equal(result.owned_error_spans.length, 6);
  assert.equal(result.transport_receipts.length, 2);
  assert(result.owned_error_spans.some((s) => s.span_id === f.server.spanID));
  assert.deepEqual(f.trace, before);
});
test("Runtime completion may retain its one-microsecond Jaeger representation ambiguity", () => {
  const f = runtimeCancellationFixture();
  f.operation.logs[0].timestamp = end(f.operation) + 1;
  inspect(f);
});
for (const [name, mutate] of [
  ["wrong Run", (f) => set(f.run, "antnest.run.id", "other")],
  [
    "wrong organization",
    (f) => set(f.tool, "antnest.organization.id", "other"),
  ],
  [
    "wrong Runtime execution",
    (f) => set(f.operation, "antnest.runtime.execution.id", "other"),
  ],
  [
    "foreign executor group",
    (f) => set(f.executor, "executor.child.pid", "31"),
  ],
  [
    "different generation",
    (f) => set(f.runtimeTool, "antnest.runtime.generation", "2"),
  ],
  [
    "successful Run terminal",
    (f) => set(f.run, "run.terminal_class", "completed"),
  ],
  ["known effects", (f) => set(f.run, "run.tool_effect_state", "none")],
  [
    "different unknown source",
    (f) => set(f.run, "run.unknown_effect_source", "model"),
  ],
  ["different tool source", (f) => set(f.tool, "mcp.source_id", "managed")],
  [
    "Runtime successful protocol",
    (f) => set(f.server, "antnest.protocol.outcome", "success"),
  ],
  [
    "Runtime successful transport",
    (f) => set(f.server, "http.transport.outcome", "success"),
  ],
  ["different transport cause", (f) => set(f.server, "error.type", "timeout")],
  [
    "HTTP receipt bytes differ",
    (f) => set(f.client, "http.response.body.size", 191),
  ],
  [
    "empty HTTP receipt",
    (f) => {
      set(f.client, "http.response.body.size", 0);
      set(f.server, "http.response.body.size", 0);
    },
  ],
  [
    "unsuccessful HTTP",
    (f) => set(f.server, "http.response.status_code", "503"),
  ],
  [
    "contradictory status alias",
    (f) => set(f.server, "http.status_code", "503"),
  ],
  ["client became ERROR", (f) => set(f.client, "otel.status_code", "ERROR")],
  ["server became ERROR", (f) => set(f.server, "error", true)],
  [
    "executor not cancelled",
    (f) => set(f.executor, "executor.exit.classification", "success"),
  ],
  ["unexpected exit code", (f) => set(f.executor, "process.exit.code", 0)],
  ["unexpected exit signal", (f) => set(f.executor, "executor.exit.signal", 9)],
  [
    "missing error event",
    (f) => {
      f.operation.logs.pop();
    },
  ],
  [
    "duplicate completion",
    (f) => f.runtimeTool.logs.push(structuredClone(f.runtimeTool.logs[0])),
  ],
  [
    "unrelated cause chain",
    (f) => {
      const e = f.executor.logs[1];
      e.fields = e.fields.filter((x) => x.key !== "antnest.error.cause_types");
      e.fields.push({ key: "antnest.error.cause_types", value: '["timeout"]' });
    },
  ],
  [
    "unregistered private message",
    (f) => {
      f.tool.logs[0].fields.find(
        (x) => x.key === "antnest.error.message",
      ).value = "private error";
    },
  ],
  [
    "event outside Runtime span",
    (f) => {
      f.operation.logs[0].timestamp = end(f.operation) + 2;
    },
  ],
  [
    "event predates ACP operation",
    (f) => {
      f.tool.logs[0].timestamp = f.tool.startTime - 1;
    },
  ],
  ["unrelated error elsewhere", (f) => set(f.model, "error", true)],
  [
    "detached Runtime operation",
    (f) => {
      f.operation.references[0].spanID = f.first.server.spanID;
    },
  ],
])
  test(`held Runtime cancellation rejects ${name}`, () => {
    const f = runtimeCancellationFixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });
for (const which of [
  "run",
  "tool",
  "client",
  "server",
  "operation",
  "runtimeTool",
  "executor",
])
  for (const field of [
    "error.detail",
    "exception.type",
    "antnest.error.unclassified",
    "antnest.cancellation.unclassified",
    "antnest.result",
    "jsonrpc.error_code",
    "rpc.response.status_code",
  ])
    test(`held Runtime cancellation rejects extra ${which} ${field}`, () => {
      const f = runtimeCancellationFixture();
      inspect(f);
      set(f[which], field, "unexpected");
      assert.throws(() => inspect(f));
    });
for (const which of [
  "run",
  "tool",
  "client",
  "server",
  "operation",
  "runtimeTool",
  "executor",
])
  test(`held Runtime cancellation rejects duplicate ${which} fields`, () => {
    const f = runtimeCancellationFixture();
    inspect(f);
    f[which].tags.push({ ...f[which].tags[0] });
    assert.throws(() => inspect(f));
  });
