import assert from "node:assert/strict";
import test from "node:test";
import * as load from "./resolve-cache-load.mjs";
import {
  loadFixture,
  addInitializeCatalog,
} from "./resolve-cache-load-fixtures.mjs";
import {
  setTag,
  addResolveRPC,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

const inspect = (f) =>
  load.inspectResolveLoad(f.wire, f.agentID, f.settings, f, [
    "synthetic-private-token",
  ]);

test("HTTPS load proves all 100 exchanges and independently counts handshake and refresh RPCs", () => {
  const f = loadFixture();
  const raw = JSON.stringify([...f.traces.values()]);
  const result = inspect(f);
  assert.equal(result.exchanges, 100);
  assert.equal(result.elapsed_ms, 5990);
  assert.equal(result.gateway_rpc_attempts, 2);
  assert.equal(result.identity_rpc_receipts, 2);
  assert.equal(result.background_refreshes, 1);
  assert.equal(result.message_traces, 101);
  assert.equal(JSON.stringify([...f.traces.values()]), raw);
});

test("successful Initialize catalog keeps Runtime's empty error type and all raw diagnostics", () => {
  const f = loadFixture();
  const { operation } = addInitializeCatalog(f);
  operation.warnings = ["raw runtime clock diagnostic"];
  const before = JSON.stringify([...f.traces.values()]);
  const result = inspect(f);
  assert.equal(result.error_spans, 0);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(result.warnings, ["raw runtime clock diagnostic"]);
  assert.equal(JSON.stringify([...f.traces.values()]), before);
});

test("empty Runtime error type cannot hide failed outcomes, status, HTTP or events", () => {
  for (const mutate of [
    ...["runtime_busy", null, false, 0].map(
      (value) => (span) => setTag(span, "error.type", value),
    ),
    (span) => setTag(span, "error", true),
    (span) => setTag(span, "otel.status_code", "ERROR"),
    (span) => setTag(span, "otel.status_code", 2),
    (span) => setTag(span, "otel.status_code", undefined),
    (span) => setTag(span, "http.response.status_code", 503),
    (span) => setTag(span, "antnest.outcome", "error"),
    (span) => setTag(span, "antnest.operation.outcome", "error"),
    (span) => setTag(span, "mcp.operation.outcome", "error"),
    (span) => setTag(span, "mcp.operation.outcome", undefined),
    (span) => setTag(span, "antnest.operation.outcome", undefined),
    (span) =>
      span.logs.push({
        timestamp: span.startTime,
        fields: fields({ event: "antnest.error" }),
      }),
  ]) {
    const f = loadFixture();
    const { operation } = addInitializeCatalog(f);
    assert.equal(inspect(f).strict_trace, "passed");
    mutate(operation);
    assert.throws(() => inspect(f));
  }
});

for (const [name, mutate] of [
  ["missing upgrade Trace", (f) => delete f.wire.upgrade.trace_id],
  ["non-upgraded connection", (f) => (f.wire.upgrade.status = 200)],
  ["elapsed starts after dial", (f) => (f.wire.started_at = 25)],
  ["over eight seconds", (f) => (f.wire.completed_at = 8011)],
  ["missing actual reply", (f) => f.wire.frames.pop()],
  ["duplicate reply", (f) => f.wire.frames.push(f.wire.frames.at(-1))],
  ["missing initialize", (f) => f.wire.frames.splice(0, 2)],
  [
    "RPC error reply",
    (f) =>
      (f.wire.frames[3].raw = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603 },
      })),
  ],
  [
    "wrong response ID",
    (f) =>
      (f.wire.frames[3].raw = JSON.stringify({
        jsonrpc: "2.0",
        id: "foreign",
        result: { sessions: [] },
      })),
  ],
  [
    "wrong list shape",
    (f) =>
      (f.wire.frames[3].raw = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {},
      })),
  ],
  ["message outside elapsed window", (f) => (f.wire.frames.at(-1).at = 6001)],
  ["disabled cache", (f) => (f.settings.resolveTTLMS = 0)],
  ["captured content", (f) => (f.settings.captureRpcContent = true)],
  ["missing message trace", (f) => f.traces.delete([...f.traces.keys()][2])],
  ["missing synchronous parent", (f) => f.refresh.spans.splice(0, 1)],
  [
    "foreign background trigger",
    (f) => (f.refresh.spans[0].references[0].traceID = "e".repeat(32)),
  ],
  [
    "invented background trigger span",
    (f) => (f.refresh.spans[0].references[0].spanID = "missing"),
  ],
  [
    "missing Identity receipt",
    (f) =>
      (f.refresh.spans = f.refresh.spans.filter(
        (s) => !["resolve-server", "sql"].includes(s.spanID),
      )),
  ],
  [
    "missing Gateway attempt",
    (f) =>
      (f.refresh.spans = f.refresh.spans.filter(
        (s) => s.spanID !== "resolve-client",
      )),
  ],
  [
    "four actual attempts",
    (f) => {
      addResolveRPC(f.refresh, "2", 1051000);
      addResolveRPC(f.refresh, "3", 1051000);
    },
  ],
  [
    "unpaired extra Gateway attempt",
    (f) => {
      const { server, sql } = addResolveRPC(f.refresh, "extra", 1051000);
      f.refresh.spans = f.refresh.spans.filter(
        (s) => s !== server && s !== sql,
      );
    },
  ],
  [
    "duplicate Identity receipt",
    (f) => {
      const copy = structuredClone(
        f.refresh.spans.find((s) => s.spanID === "resolve-server"),
      );
      copy.spanID = "duplicate";
      f.refresh.spans.push(copy);
    },
  ],
  [
    "actual Resolve error",
    (f) =>
      setTag(
        f.refresh.spans.find((s) => s.spanID === "resolve-client"),
        "error",
        true,
      ),
  ],
  ["secret in source", (f) => (f.refresh.private = "synthetic-private-token")],
  ["unarchived refresh", (f) => f.archivedTraceIDs.delete(f.refresh.traceID)],
])
  test(`HTTPS load rejects ${name}`, () => {
    const f = loadFixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("load retains raw warnings and strict failure without relaxing the RPC gate", () => {
  const f = loadFixture();
  f.refresh.warnings = ["unknown diagnostic warning"];
  const result = inspect(f);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(result.warnings, ["unknown diagnostic warning"]);
  assert.deepEqual(f.refresh.warnings, ["unknown diagnostic warning"]);
});

test("load includes connection probes, deduplicates shared RPC sources and finds a last-message refresh", () => {
  const f = loadFixture();
  const connection = f.traces.get(f.wire.upgrade.trace_id);
  const initial = connection.spans.find((span) => span.spanID === "decision");
  connection.spans.push({
    ...structuredClone(initial),
    spanID: "probe",
    startTime: 1050000,
    duration: 5000,
  });
  addResolveRPC(connection, "probe", 1051000);
  const messages = [...f.traces.values()].slice(1, -1);
  const waiter = messages[1].spans.find((span) => span.spanID === "decision");
  setTag(waiter, "antnest.identity.resolve.source", "shared");
  setTag(
    waiter,
    "antnest.identity.resolve.shared_source_state",
    "actual-client",
  );
  waiter.references.push({
    refType: "FOLLOWS_FROM",
    traceID: connection.traceID,
    spanID: "resolve-client",
  });
  f.refresh.spans[0].references[0].traceID = messages.at(-1).traceID;
  const result = inspect(f);
  assert.equal(result.gateway_rpc_attempts, 3);
  assert.equal(result.identity_rpc_receipts, 3);
  assert.equal(result.background_refreshes, 1);
});
