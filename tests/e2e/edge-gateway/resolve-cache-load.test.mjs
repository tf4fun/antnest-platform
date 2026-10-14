import assert from "node:assert/strict";
import test from "node:test";
import * as load from "./resolve-cache-load.mjs";
import {
  loadFixture as requestFixture,
  addInitializeCatalog,
  addInitializeCatalogEvents,
} from "./resolve-cache-load-fixtures.mjs";
import { addLoadCleanup } from "./resolve-cache-load-close-fixtures.mjs";
const loadFixture = () => addLoadCleanup(requestFixture());
import {
  setTag,
  addResolveRPC,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

const inspect = (f) =>
  load.inspectResolveLoad(f.wire, f.agentID, f.settings, f, [
    "synthetic-private-token",
  ]);
const setEventField = (row, key, value) => {
  const span = { tags: row.event.fields };
  setTag(span, key, value);
  row.event.fields = span.tags;
};

test("load accepts initialize HTTP 200 and session/list HTTP 202 receipts", () => {
  const f = loadFixture();
  for (const trace of f.traces.values())
    for (const span of trace.spans)
      if (span.spanID === "list")
        setTag(span, "http.response.status_code", 202);
  const raw = JSON.stringify([...f.traces.values()]);
  assert.equal(inspect(f).requests.length, 100);
  assert.equal(JSON.stringify([...f.traces.values()]), raw);
});

test("load rejects a synchronous 200 session/list in the connection-stream workflow", () => {
  const f = loadFixture();
  const trace = f.traces.get(f.wire.requests[1].trace_id);
  setTag(
    trace.spans.find((span) => span.spanID === "list"),
    "http.response.status_code",
    200,
  );
  assert.throws(() => inspect(f), /session\/list.*HTTP receipt/u);
});

test("load rejects initialize HTTP 202 without its synchronous connection response", () => {
  const f = loadFixture();
  const trace = f.traces.get(f.wire.requests[0].trace_id);
  setTag(
    trace.spans.find((span) => span.spanID === "initialize"),
    "http.response.status_code",
    202,
  );
  assert.throws(() => inspect(f), /initialize.*HTTP receipt/u);
});

function wrapListSQL(trace, { name, kind = "client", processID = "acp" }) {
  const sql = trace.spans.find((span) => span.spanID === "list-sql");
  const wrapper = {
    ...structuredClone(sql),
    spanID: "list-db-wrapper",
    operationName: name,
    processID,
    tags: fields({ "span.kind": kind, "db.system.name": "postgresql" }),
  };
  sql.references[0].spanID = wrapper.spanID;
  trace.spans.push(wrapper);
  return wrapper;
}

for (const [name, mutate] of [
  [
    "SQL from another process with the same service name",
    (trace) => {
      trace.processes.foreign = { serviceName: "agent-acp-service" };
      trace.spans.find((span) => span.spanID === "list-sql").processID =
        "foreign";
    },
  ],
  [
    "business operation and SQL from a different ACP process",
    (trace) => {
      trace.processes.foreign = { serviceName: "agent-acp-service" };
      for (const id of ["list-operation", "list-sql"])
        trace.spans.find((span) => span.spanID === id).processID = "foreign";
    },
  ],
  [
    "non-driver internal wrapper between SQL and its business operation",
    (trace) => {
      const wrapper = wrapListSQL(trace, {
        name: "unrelated work",
        kind: "internal",
      });
      wrapper.tags = fields({ "span.kind": "internal" });
    },
  ],
  [
    "connection wrapper from a different process",
    (trace) => {
      trace.processes.foreign = { serviceName: "agent-acp-service" };
      wrapListSQL(trace, { name: "connect", processID: "foreign" });
    },
  ],
  [
    "additional query execution missing its SQL text",
    (trace) => {
      const extra = structuredClone(
        trace.spans.find((span) => span.spanID === "list-sql"),
      );
      extra.spanID = "list-query-without-sql";
      extra.tags = extra.tags.filter((field) => field.key !== "db.query.text");
      trace.spans.push(extra);
    },
  ],
  [
    "captured SQL parameters in driver diagnostics",
    (trace) => {
      trace.spans
        .find((span) => span.spanID === "list-sql")
        .logs.push({
          fields: fields({ "db.query.parameters": "private-value" }),
        });
    },
  ],
]) {
  test(`session-list database evidence rejects ${name}`, () => {
    const f = loadFixture();
    inspect(f);
    mutate(f.traces.get(f.wire.requests[1].trace_id));
    assert.throws(() => inspect(f));
  });
}

for (const wrapper of [
  { name: "connect" },
  { name: "batch start" },
  { name: "postgresql transaction", kind: "internal" },
]) {
  test(`session-list SQL count excludes its legitimate ${wrapper.name} wrapper`, () => {
    const f = loadFixture();
    const trace = f.traces.get(f.wire.requests[1].trace_id);
    wrapListSQL(trace, wrapper);
    const raw = JSON.stringify([...f.traces.values()]);
    const result = inspect(f);
    assert.equal(result.requests[1].list_sql, 1);
    assert.equal(JSON.stringify([...f.traces.values()]), raw);
  });
}

test("Bridge load proves all 100 HTTP requests and independently counts initial and final refresh RPCs", () => {
  const f = loadFixture();
  const raw = JSON.stringify([...f.traces.values()]);
  const result = inspect(f);
  assert.equal(result.exchanges, 100);
  assert.equal(result.elapsed_ms, 5990);
  assert.equal(result.gateway_rpc_attempts, 2);
  assert.equal(result.identity_rpc_receipts, 2);
  assert.equal(result.background_refreshes, 1);
  assert.equal(result.http_traces, 100);
  assert.equal(JSON.stringify([...f.traces.values()]), raw);
});

test("successful Initialize catalog keeps Runtime's empty error type and all raw diagnostics", () => {
  const f = loadFixture();
  const { operation } = addInitializeCatalog(f);
  operation.warnings = ["raw runtime clock diagnostic"];
  const before = JSON.stringify([...f.traces.values()]);
  const result = inspect(f);
  assert.equal(result.error_spans, 2);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(result.warnings, ["raw runtime clock diagnostic"]);
  assert.equal(JSON.stringify([...f.traces.values()]), before);
});

test("actual Runtime catalog success events preserve their empty error placeholders", () => {
  const f = loadFixture();
  const rows = addInitializeCatalogEvents(f);
  assert.equal(rows.length, 5);
  const raw = JSON.stringify([...f.traces.values()]);
  const result = inspect(f);
  assert.equal(
    result.error_spans,
    2,
    "only the original owned stream errors are raw errors",
  );
  assert.equal(result.strict_trace, "failed");
  assert.equal(JSON.stringify([...f.traces.values()]), raw);
});

test("Runtime success logs cannot borrow matching metadata from a foreign Agent", () => {
  const f = loadFixture();
  const row = addInitializeCatalogEvents(f)[0];
  inspect(f);
  setTag(row.span, "antnest.agent.id", "foreign");
  setEventField(row, "antnest.agent.id", "foreign");
  assert.throws(() => inspect(f));
});

test("Runtime empty span placeholder cannot mask a duplicate nonempty error.type", () => {
  const f = loadFixture();
  const rows = addInitializeCatalogEvents(f);
  inspect(f);
  const row = rows.find(
    (row) => row.span.operationName === "runtime.mcp.operation",
  );
  row.span.tags.push(...fields({ "error.type": "actual_failure" }));
  assert.throws(() => inspect(f));
});

for (const [name, mutate] of [
  [
    "nonempty error",
    (row) => setEventField(row, "error.type", "actual_failure"),
  ],
  [
    "extra error diagnostic",
    (row) => row.event.fields.push(...fields({ "error.message": "failure" })),
  ],
  [
    "exception",
    (row) => row.event.fields.push(...fields({ "exception.type": "Failure" })),
  ],
  ["error log level", (row) => setEventField(row, "level", "ERROR")],
  [
    "foreign event Trace",
    (row) => setEventField(row, "trace_id", "f".repeat(32)),
  ],
  ["foreign event span", (row) => setEventField(row, "span_id", "foreign")],
  ["foreign Agent", (row) => setEventField(row, "antnest.agent.id", "foreign")],
  ["foreign service", (row) => setEventField(row, "service.name", "other")],
  ["unknown event", (row) => setEventField(row, "event", "unknown completion")],
  [
    "duplicate placeholder",
    (row) => row.event.fields.push(...fields({ "error.type": "failure" })),
  ],
  [
    "failed extra outcome",
    (row) => row.event.fields.push(...fields({ "antnest.outcome": "error" })),
  ],
]) {
  test(`Runtime catalog placeholders cannot hide ${name}`, () => {
    const f = loadFixture();
    const rows = addInitializeCatalogEvents(f);
    inspect(f);
    for (let index = 0; index < rows.length; index++) {
      const candidate = loadFixture();
      const row = addInitializeCatalogEvents(candidate)[index];
      const before = JSON.stringify(row.span);
      mutate(row);
      assert.notEqual(
        JSON.stringify(row.span),
        before,
        "fixture mutation must change the actual span",
      );
      assert.throws(
        () => inspect(candidate),
        undefined,
        row.span.operationName,
      );
    }
  });
}

for (const [name, select, change] of [
  [
    "HTTP event outcome",
    (r) => r.span.operationName === "HTTP POST /mcp",
    (r) => setEventField(r, "http.transport.outcome", "canceled"),
  ],
  [
    "HTTP event status",
    (r) => r.span.operationName === "HTTP POST /mcp",
    (r) => setEventField(r, "http.status_code", "503"),
  ],
  [
    "MCP event outcome",
    (r) => r.span.operationName === "runtime.mcp.operation",
    (r) => setEventField(r, "mcp.operation.outcome", "error"),
  ],
  [
    "MCP event method",
    (r) => r.span.operationName === "runtime.mcp.operation",
    (r) => setEventField(r, "mcp.operation.name", "tools/call"),
  ],
  [
    "Executor event outcome",
    (r) => r.span.operationName === "runtime.executor",
    (r) => setEventField(r, "outcome", "canceled"),
  ],
  [
    "Executor span outcome",
    (r) => r.span.operationName === "runtime.executor",
    (r) => setTag(r.span, "executor.outcome", "error"),
  ],
]) {
  test(`Runtime catalog rejects mismatched ${name}`, () => {
    const f = loadFixture();
    const row = addInitializeCatalogEvents(f).find(select);
    inspect(f);
    const before = JSON.stringify(row.span);
    change(row);
    assert.notEqual(
      JSON.stringify(row.span),
      before,
      "fixture mutation must change the actual span",
    );
    assert.throws(() => inspect(f));
  });
}

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
    assert.equal(inspect(f).strict_trace, "failed");
    mutate(operation);
    assert.throws(() => inspect(f));
  }
});

for (const [name, mutate] of [
  [
    "missing first initialize",
    (f) => {
      const first = f.traces.get(f.wire.requests[0].trace_id);
      first.spans = first.spans.filter((s) => s.spanID !== "initialize");
    },
  ],
  [
    "warm initial Resolve",
    (f) => {
      const first = f.traces.get(f.wire.requests[0].trace_id);
      setTag(
        first.spans.find((s) => s.spanID === "decision"),
        "antnest.identity.resolve.source",
        "cache",
      );
    },
  ],
  [
    "missing actual HTTP trace",
    (f) => f.traces.delete(f.wire.requests[1].trace_id),
  ],
  [
    "foreign Agent receipt",
    (f) =>
      setTag(
        f.traces
          .get(f.wire.requests[1].trace_id)
          .spans.find((s) => s.spanID === "list"),
        "antnest.agent.id",
        "other",
      ),
  ],
  [
    "wrong private ACP listener",
    (f) =>
      setTag(
        f.traces
          .get(f.wire.requests[1].trace_id)
          .spans.find((s) => s.spanID === "list"),
        "antnest.listener",
        "control",
      ),
  ],
  [
    "missing Bridge receiver",
    (f) => {
      const t = f.traces.get(f.wire.requests[1].trace_id);
      t.spans = t.spans.filter((s) => s.spanID !== "ui");
    },
  ],
  [
    "list receipt reparented past Bridge",
    (f) => {
      f.traces
        .get(f.wire.requests[1].trace_id)
        .spans.find((s) => s.spanID === "list").references[0].spanID = "root";
    },
  ],
  [
    "missing session-list business operation",
    (f) => {
      f.traces
        .get(f.wire.requests[1].trace_id)
        .spans.find((s) => s.spanID === "list-operation").operationName =
        "other";
    },
  ],
  [
    "missing session-list SQL",
    (f) => {
      const t = f.traces.get(f.wire.requests[1].trace_id);
      t.spans = t.spans.filter((s) => s.spanID !== "list-sql");
    },
  ],
  [
    "session SQL borrowed from initialize",
    (f) => {
      const t = f.traces.get(f.wire.requests[0].trace_id);
      t.spans.find((s) => s.spanID === "list-sql").references[0].spanID =
        "initialize";
    },
  ],
  [
    "failed non-Resolve SQL",
    (f) =>
      setTag(
        f.traces
          .get(f.wire.requests[1].trace_id)
          .spans.find((s) => s.spanID === "list-sql"),
        "error",
        true,
      ),
  ],
  [
    "early refresh substitutes for final request",
    (f) => {
      f.refresh.spans[0].references[0].traceID = f.wire.requests[98].trace_id;
    },
  ],
  ["no completed final refresh", (f) => f.traces.delete(f.refresh.traceID)],
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
      addResolveRPC(f.refresh, "2", f.refresh.spans[0].startTime + 1000);
      addResolveRPC(f.refresh, "3", f.refresh.spans[0].startTime + 1000);
    },
  ],
  [
    "unpaired extra Gateway attempt",
    (f) => {
      const { server, sql } = addResolveRPC(
        f.refresh,
        "extra",
        f.refresh.spans[0].startTime + 1000,
      );
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

test("load deduplicates a shared initial RPC and still requires the final HTTP refresh", () => {
  const f = loadFixture();
  const first = f.traces.get(f.wire.requests[0].trace_id);
  const waiter = f.traces
    .get(f.wire.requests[1].trace_id)
    .spans.find((span) => span.spanID === "decision");
  for (const name of ["snapshot_age_ms", "proof_age_ms", "valid_for_ms"])
    setTag(waiter, "antnest.identity.resolve." + name, undefined);
  setTag(waiter, "antnest.identity.resolve.source", "shared");
  setTag(
    waiter,
    "antnest.identity.resolve.shared_source_state",
    "actual-client",
  );
  waiter.references.push({
    refType: "FOLLOWS_FROM",
    traceID: first.traceID,
    spanID: "resolve-client",
  });
  const result = inspect(f);
  assert.equal(result.gateway_rpc_attempts, 2);
  assert.equal(result.identity_rpc_receipts, 2);
});

test("load accepts the SDK dispatch child shape without inventing an Agent UI CLIENT span", () => {
  const f = loadFixture();
  const trace = f.traces.get(f.wire.requests[1].trace_id);
  const http = trace.spans.find((s) => s.spanID === "list");
  const dispatch = structuredClone(http);
  dispatch.spanID = "list-dispatch";
  dispatch.operationName = "acp session/list";
  dispatch.references[0].spanID = http.spanID;
  dispatch.tags = dispatch.tags.filter(
    (field) =>
      !field.key.startsWith("http.") && field.key !== "antnest.listener",
  );
  http.tags = http.tags.filter(
    (field) =>
      !field.key.startsWith("rpc.") &&
      ![
        "antnest.agent.id",
        "antnest.request.id",
        "antnest.protocol.version",
      ].includes(field.key),
  );
  trace.spans.push(dispatch);
  trace.spans.find((s) => s.spanID === "list-operation").references[0].spanID =
    dispatch.spanID;
  assert.equal(inspect(f).http_traces, 100);
});

test("failed CLIENT attempts count toward the independent budget without receiving SERVERs", () => {
  const f = loadFixture();
  for (let n = 0; n < 2; n++) {
    const { client, server, sql } = addResolveRPC(
      f.refresh,
      String(n),
      f.refresh.spans[0].startTime + 1000,
    );
    setTag(client, "http.response.status_code", undefined);
    setTag(client, "error", true);
    f.refresh.spans = f.refresh.spans.filter((s) => s !== server && s !== sql);
  }
  assert.throws(
    () => inspect(f),
    /Gateway actual Resolve attempts exceed budget/u,
  );
});

test("Identity SERVER inventory has its own budget before any CLIENT pairing", () => {
  const f = loadFixture();
  const server = f.refresh.spans.find((s) => s.spanID === "resolve-server");
  for (const suffix of ["2", "3"])
    f.refresh.spans.push({
      ...structuredClone(server),
      spanID: "server" + suffix,
    });
  assert.throws(
    () => inspect(f),
    /Identity actual Resolve receipts exceed budget/u,
  );
});

for (const name of [
  "late first-trace SQL warning",
  "late refresh SQL warning",
]) {
  test(name + " preserves raw strict failure", () => {
    const f = loadFixture();
    const trace = name.includes("first")
      ? f.traces.get(f.wire.requests[0].trace_id)
      : f.refresh;
    trace.spans.at(-1).warnings = [name];
    const before = JSON.stringify([...f.traces.values()]);
    const result = inspect(f);
    assert.equal(result.strict_trace, "failed");
    assert(result.warnings.includes(name));
    assert.equal(JSON.stringify([...f.traces.values()]), before);
  });
}
