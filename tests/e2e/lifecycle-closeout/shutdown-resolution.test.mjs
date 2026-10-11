import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as evidence from "./shutdown-evidence.mjs";
import * as shutdown from "./shutdown.mjs";
import {
  shutdownResolutionFixture,
  addShutdownCheck,
} from "./shutdown-resolution-fixtures.mjs";
import {
  resolvePrefix as prefix,
  setTag,
  sourceID,
  triggerID,
} from "../observability/gateway-resolution-fixtures.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";

const inspect = (f) =>
  evidence.inspectShutdownTrace(f.trace, f.expected, ["PRIVATE"], f);
for (const executionState of [false, true])
  for (const source of ["rpc", "cache", "shared"])
    test(`${executionState ? "state" : "events"} shutdown validates ${source} initial admission and cache revalidation`, () => {
      const f = shutdownResolutionFixture(source, executionState);
      addShutdownCheck(f, {
        source: "cache",
        outcome: "admitted",
        start: 1500000,
      });
      const raw = JSON.stringify([...f.traces.values()]);
      const result = inspect(f);
      assert.equal(result.gateway_resolution.source, source);
      assert.equal(
        result.gateway_resolution.profile,
        executionState ? "workspace" : "console",
      );
      assert.equal(result.gateway_revalidations.length, 1);
      assert.equal(result.gateway_revalidations[0].admission, true);
      assert.equal(result.identity_sql, source === "cache" ? 0 : 1);
      assert.equal(result.remote_closure_verified, true);
      assert.equal(JSON.stringify([...f.traces.values()]), raw);
    });

for (const [name, change] of [
  [
    "missing initial marker",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.decision), 1),
  ],
  ["wrong profile", (f) => setTag(f.decision, prefix + "profile", "acp")],
  ["expired hit", (f) => setTag(f.decision, prefix + "snapshot_age_ms", 10000)],
  ["late initial admission", (f) => (f.decision.duration = 50000)],
  [
    "wrong Gateway forwarding",
    (f) => (f.upstream.operationName = "HTTP GET unrelated"),
  ],
  [
    "nested Gateway forwarding",
    (f) => (f.upstream.references[0].spanID = f.decision.spanID),
  ],
  ["no remote observation", (f) => delete f.expected.closure],
  ["local close", (f) => (f.expected.closure.kind = "local-close")],
  ["global abort", (f) => (f.expected.closure.kind = "global-abort")],
  ["foreign closure", (f) => (f.expected.closure.traceID = "f".repeat(32))],
  ["closure before actual stop", (f) => (f.expected.closure.observedAt = 1999)],
  ["late closure", (f) => (f.expected.closure.observedAt = 3501)],
  ["no delivered events", (f) => (f.expected.closure.receivedEvents = 0)],
  ["widened stop tolerance", (f) => (f.expected.stopWindow.start = 0)],
  ["no clean stop inventory", (f) => delete f.expected.stop],
  ["Gateway still running", (f) => (f.expected.stop.after[0].running = true)],
  ["Gateway killed", (f) => (f.expected.stop.after[0].exit = 137)],
  [
    "stale clean stop",
    (f) => (f.expected.stop.after[0].finished = new Date(500).toISOString()),
  ],
  ["replacement Gateway", (f) => (f.expected.stop.after[0].id = "replacement")],
  ["late live observation", (f) => (f.expected.stop.liveAt = 2001)],
])
  test(`shutdown Resolve gate rejects ${name}`, () => {
    const f = shutdownResolutionFixture("cache");
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  ["archive absent", (f) => f.archivedTraceIDs.delete(sourceID)],
  ["source SQL absent", (f) => f.traces.get(sourceID).spans.pop()],
  [
    "source SQL error",
    (f) => setTag(f.traces.get(sourceID).spans.at(-1), "error", true),
  ],
  [
    "source RPC error",
    (f) =>
      setTag(
        f.origin.trace.spans.find((s) => s.spanID === "resolve-client"),
        "error",
        true,
      ),
  ],
  [
    "source parent absent",
    (f) =>
      (f.origin.trace.spans.find(
        (s) => s.spanID === "resolve-client",
      ).references[0].spanID = "missing"),
  ],
  [
    "trigger private data",
    (f) => (f.traces.get(triggerID).private = "PRIVATE"),
  ],
  [
    "source unknown diagnostic",
    (f) => setTag(f.origin.root, prefix + "secret", "value"),
  ],
])
  test(`shutdown shared provenance rejects ${name}`, () => {
    const f = shutdownResolutionFixture("shared");
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });

for (const executionState of [false, true])
  for (const cancelKind of ["caller-cancelled", "process-shutdown"])
    test(`${executionState ? "state" : "events"} pending ${cancelKind} before CLIENT is cancellation, never admission`, () => {
      const f = shutdownResolutionFixture("cache", executionState);
      addShutdownCheck(f, { cancelKind });
      const result = inspect(f);
      assert.equal(result.gateway_revalidations[0].admission, false);
      assert.equal(result.gateway_revalidations[0].cancellation_verified, true);
      assert.equal(result.identity_checks, 0);
      assert.equal(result.cancellation_error_spans, 1);
      assert.equal(result.strict_trace, "failed");
    });

for (const source of ["rpc", "shared"])
  for (const receiver of [false, true])
    test(`${source} cancelled actual CLIENT ${receiver ? "with" : "without"} a receipt retains exact pending cancellation`, () => {
      const f = shutdownResolutionFixture();
      const actual = addShutdownCheck(f, {
        source,
        state: "actual-client",
        cancelledClient: true,
        receiver,
      });
      const result = inspect(f);
      const record = result.gateway_revalidations[0];
      assert.equal(record.rpc_client_span_id, actual.client.spanID);
      assert.equal(record.admission, false);
      assert.equal(record.cancellation_verified, true);
      assert.equal(result.identity_sql, receiver ? 1 : 0);
      assert.equal(result.cancellation_error_spans, source === "rpc" ? 2 : 1);
    });

test("shared cancelled waiter permits retained successful background RPC and never absorbs its source diagnostics", () => {
  const f = shutdownResolutionFixture();
  const actual = addShutdownCheck(f, { state: "actual-client" });
  actual.client.duration = 6000;
  const result = inspect(f);
  assert.equal(result.gateway_revalidations[0].admission, false);
  assert.equal(result.identity_sql, 1);
  assert.equal(result.cancellation_error_spans, 1);
  setTag(actual.root, prefix + "outcome", "unavailable");
  setTag(actual.root, "error", true);
  setTag(actual.root, "otel.status_description", "unavailable");
  const discarded = inspect(f);
  assert.equal(discarded.error_spans, 2);
  assert.equal(discarded.cancellation_error_spans, 1);
  assert.equal(discarded.strict_trace, "failed");
});

test("parallel probes are not ordered by marker completion as if it were a cancellation anchor", () => {
  const f = shutdownResolutionFixture("cache", true);
  addShutdownCheck(f, { start: 2100000, duration: 30000 });
  addShutdownCheck(f, { start: 2105000, duration: 5000 });
  addShutdownCheck(f, { start: 2115000, duration: 10000 });
  const result = inspect(f);
  assert.equal(result.gateway_revalidations.length, 3);
  assert.equal(result.cancellation_error_spans, 3);
});

for (const [name, change] of [
  [
    "deadline kind",
    (f, a) => setTag(a.decision, prefix + "cancel_kind", "caller-deadline"),
  ],
  [
    "unknown kind",
    (f, a) => setTag(a.decision, prefix + "cancel_kind", "capacity"),
  ],
  [
    "invented pre-CLIENT link",
    (f, a) =>
      a.decision.references.push({
        refType: "FOLLOWS_FROM",
        traceID: f.trace.traceID,
        spanID: "upstream",
      }),
  ],
  ["failure before stop", (f, a) => (a.decision.startTime = 1000000)],
  [
    "initial unavailable",
    (f, a) => setTag(f.decision, prefix + "outcome", "unavailable"),
  ],
  [
    "unclassified rpc without CLIENT",
    (f, a) => {
      setTag(a.decision, prefix + "source", "rpc");
      setTag(a.decision, prefix + "shared_source_state", undefined);
      setTag(a.decision, prefix + "cancel_kind", undefined);
    },
  ],
])
  test(`shutdown cannot infer cancellation from ${name}`, () => {
    const f = shutdownResolutionFixture();
    const actual = addShutdownCheck(f);
    inspect(f);
    change(f, actual);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  [
    "CLIENT created after snapshot",
    (f, a) =>
      (a.client.startTime = a.decision.startTime + a.decision.duration + 1),
  ],
  ["HTTP 503", (f, a) => setTag(a.client, "http.response.status_code", 503)],
  [
    "unknown error stage",
    (f, a) =>
      (a.client.logs[0].fields.find(
        (x) => x.key === "antnest.error.stage",
      ).value = "unknown"),
  ],
  [
    "conflicting error event",
    (f, a) =>
      a.client.logs[0].fields.push({
        key: "antnest.error.code",
        value: "dependency_unavailable",
      }),
  ],
  ["SQL error", (f, a) => setTag(a.sql, "error", true)],
  [
    "missing source archive",
    (f, a) => f.archivedTraceIDs.delete(a.trace.traceID),
  ],
  [
    "wrong source profile",
    (f, a) => setTag(a.root, prefix + "profile", "workspace"),
  ],
])
  test(`pending shared cancellation rejects ${name}`, () => {
    const f = shutdownResolutionFixture();
    const actual = addShutdownCheck(f, {
      state: "actual-client",
      cancelledClient: true,
    });
    inspect(f);
    change(f, actual);
    assert.throws(() => inspect(f));
  });

test("retained rpc cancellation may finish after its caller, while TTL zero must join synchronously", () => {
  const f = shutdownResolutionFixture("rpc");
  const actual = addShutdownCheck(f, { source: "rpc", cancelledClient: true });
  actual.client.duration = 15000;
  assert.equal(inspect(f).gateway_revalidations[0].cancellation_verified, true);
  f.expected.resolveTTLMS = 0;
  assert.throws(() => inspect(f), /synchronous/);
});
test("watch cannot finish after the same clean Gateway process has already exited", () => {
  const f = shutdownResolutionFixture();
  inspect(f);
  f.root.duration = 1600000;
  assert.throws(() => inspect(f), /Gateway process/);
});
test("typed unavailable marker cannot absorb an unrelated error event", () => {
  const f = shutdownResolutionFixture();
  const { decision } = addShutdownCheck(f);
  inspect(f);
  decision.logs = [
    {
      fields: [
        { key: "event", value: "antnest.error" },
        { key: "error.type", value: "dependency_unavailable" },
      ],
    },
  ];
  assert.throws(() => inspect(f), /unrelated Resolve/);
});
test("shared revalidation counts the actual source SQL once", () => {
  const f = shutdownResolutionFixture("shared");
  const check = structuredClone(f.decision);
  check.spanID = "later-shared";
  check.startTime = 1500000;
  f.trace.spans.push(check);
  const result = inspect(f);
  assert.equal(result.gateway_revalidations.length, 1);
  assert.equal(result.identity_checks, 1);
  assert.equal(result.identity_sql, 1);
});
test("multiple rpc creator markers cannot claim the same real CLIENT", () => {
  const f = shutdownResolutionFixture();
  const actual = addShutdownCheck(f, { source: "rpc", outcome: "admitted" });
  inspect(f);
  const duplicate = structuredClone(actual.decision);
  duplicate.spanID = "duplicate-rpc-creator";
  f.trace.spans.push(duplicate);
  assert.throws(() => inspect(f), /multiple rpc decisions/);
});
test("shared cancellation retains the original already-ended caller root and actual successful SQL", () => {
  const f = shutdownResolutionFixture();
  addShutdownCheck(f, { state: "actual-client", background: false });
  const result = inspect(f);
  assert.equal(result.gateway_revalidations[0].source_root, "request");
  assert.equal(result.identity_sql, 1);
  assert.equal(result.resolve_source_error_spans, 1);
  assert.equal(result.cancellation_error_spans, 1);
});
test("source trigger errors remain outside current cancellation classification", () => {
  const f = shutdownResolutionFixture("shared");
  setTag(f.traces.get(triggerID).spans[0], "error", true);
  const result = inspect(f);
  assert.equal(result.error_spans, 1);
  assert.equal(result.cancellation_error_spans, 0);
  assert.equal(result.strict_trace, "failed");
});

function collection(t) {
  const f = shutdownResolutionFixture("shared");
  f.directory = mkdtempSync(
    join(temporaryStorageRoot(), "shutdown-resolution-"),
  );
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  f.queries = [];
  f.request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    f.queries.push(id);
    return Response.json({ data: [f.traces.get(id)] });
  };
  f.wait = async () => {};
  f.attempts = 5;
  return f;
}
const collect = (f) => {
  assert.equal(typeof evidence.collectShutdownTrace, "function");
  return evidence.collectShutdownTrace(
    "http://jaeger",
    f.expected,
    ["PRIVATE"],
    f,
  );
};
test("shutdown collector converges complete archived sources before applying owning gate", async (t) => {
  const f = collection(t);
  const result = await collect(f);
  assert.equal(result.gateway_resolution.source, "shared");
  assert.equal(f.queries.filter((id) => id === f.trace.traceID).length, 3);
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, id + ".json"))),
      trace,
    );
});
test("late source diagnostics with unchanged span IDs reset shutdown convergence and remain strict failures", async (t) => {
  const f = collection(t);
  const request = f.request;
  let reads = 0;
  f.request = async (url) => {
    if (url.endsWith(sourceID) && ++reads === 2)
      f.origin.root.warnings = ["late source warning"];
    return request(url);
  };
  const result = await collect(f);
  assert.equal(reads, 4);
  assert.equal(result.warning_count, 1);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.cancellation_error_spans, 0);
});
test("shutdown collector cannot replace the owning admission gate", async (t) => {
  const f = collection(t);
  f.expected.closure.kind = "local-close";
  f.inspect = async () => ({ strict_trace: "passed" });
  await assert.rejects(collect(f));
});

const collectEntrypoint = (f, expectations = [f.expected], signal) => {
  assert.equal(typeof shutdown.collectShutdownWatchTraces, "function");
  return shutdown.collectShutdownWatchTraces(
    { jaeger: "http://jaeger", evidence: f.directory },
    expectations,
    ["PRIVATE"],
    signal,
    f,
  );
};
test("C5 watch collection archives actual sources and continues after one owning gate failure", async (t) => {
  const f = collection(t);
  f.expected.closure.kind = "local-close";
  f.inspect = () => assert.fail("owning gate cannot be overridden");
  const second = shutdownResolutionFixture("cache", true);
  const id = "d".repeat(32);
  second.trace.traceID =
    second.expected.traceID =
    second.expected.closure.traceID =
      id;
  for (const span of second.trace.spans) {
    span.traceID = id;
    for (const ref of span.references) ref.traceID = id;
  }
  f.traces.set(id, second.trace);
  const result = await collectEntrypoint(f, [f.expected, second.expected]);
  assert.deepEqual(
    result.map((item) => item.topology),
    ["failed", "passed"],
  );
  assert.match(
    readFileSync(
      join(f.directory, "traces", f.trace.traceID + ".failure.private.txt"),
      "utf8",
    ),
    /remote watch closure/,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.directory, "traces", sourceID + ".json"))),
    f.origin.trace,
  );
  assert.equal(result[1].gateway_resolution.profile, "workspace");
});
test("C5 watch cancellation joins the active request and cannot use an options signal instead", async (t) => {
  const f = collection(t),
    abort = new AbortController();
  let entered;
  const active = new Promise((resolve) => (entered = resolve));
  let joined = false,
    receivedReason;
  const reason = new Error("cancel C5 collection");
  const decoy = new AbortController();
  f.signal = decoy.signal;
  f.request = async (_url, options) => {
    entered();
    return new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () =>
          queueMicrotask(() => {
            joined = true;
            receivedReason = options.signal.reason;
            reject(receivedReason);
          }),
        { once: true },
      );
    });
  };
  const pending = collectEntrypoint(f, [f.expected], abort.signal);
  await active;
  abort.abort(reason);
  decoy.abort(new Error("unrelated options signal"));
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(joined, true);
  assert.equal(
    receivedReason,
    reason,
    "inner request received the wrong cancellation signal",
  );
});

for (const placement of ["rpc", "shared-client", "shared-refresh"])
  test(`Gateway ${placement} cannot outlive the cleanly stopped process`, () => {
    const f = shutdownResolutionFixture();
    const actual = addShutdownCheck(f, {
      source: placement === "rpc" ? "rpc" : "shared",
      state: "actual-client",
      cancelledClient: true,
      receiver: false,
    });
    inspect(f);
    if (placement === "shared-refresh")
      actual.root.duration = 2402000 - actual.root.startTime;
    else {
      actual.client.duration = 2402000 - actual.client.startTime;
      if (actual.root) actual.root.duration = 2402000 - actual.root.startTime;
    }
    assert.throws(() => inspect(f), /Gateway.*process/);
  });
test("independent Identity work may finish after Gateway exits", () => {
  const f = shutdownResolutionFixture();
  const actual = addShutdownCheck(f, { source: "rpc", cancelledClient: true });
  actual.server.duration = 500000;
  actual.sql.startTime = 2500000;
  assert.equal(inspect(f).identity_sql, 1);
});
for (const [name, fields] of [
  [
    "unrelated exception",
    [
      { key: "event", value: "exception" },
      { key: "exception.type", value: "SyntaxError" },
    ],
  ],
  [
    "error without stage",
    [
      { key: "event", value: "antnest.error" },
      { key: "error.type", value: "cancelled" },
    ],
  ],
  [
    "error without type",
    [
      { key: "event", value: "antnest.error" },
      { key: "antnest.error.stage", value: "send" },
    ],
  ],
])
  test(`cancelled Resolve CLIENT cannot absorb ${name}`, () => {
    const f = shutdownResolutionFixture();
    const actual = addShutdownCheck(f, {
      source: "rpc",
      cancelledClient: true,
      receiver: false,
    });
    inspect(f);
    actual.client.logs.push({ fields });
    assert.throws(() => inspect(f));
  });
for (const receiver of [false, true])
  test(`cancelled Resolve stage cannot contradict ${receiver ? "HTTP 200" : "absent response"}`, () => {
    const f = shutdownResolutionFixture();
    const actual = addShutdownCheck(f, {
      source: "rpc",
      cancelledClient: true,
      receiver,
    });
    inspect(f);
    actual.client.logs[0].fields.find(
      (field) => field.key === "antnest.error.stage",
    ).value = receiver ? "send" : "read_response";
    assert.throws(() => inspect(f), /stage/);
  });
test("successful Controller watch must use GET", () => {
  const f = shutdownResolutionFixture();
  inspect(f);
  setTag(f.receiver, "http.request.method", "POST");
  assert.throws(() => inspect(f));
});
