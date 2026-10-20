import assert from "node:assert/strict";
import test from "node:test";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import {
  addResolveRPC,
  resolutionFixture,
  sharedResolutionFixture,
  resolvePrefix as prefix,
  setTag,
  sourceID,
  triggerID,
} from "./gateway-resolution-fixtures.mjs";

const inspect = (f) => inspectGatewayResolution(f.trace, f.expected, f);

for (const source of ["rpc", "cache", "shared"])
  for (const kind of ["shared-deadline", "caller-cancelled"])
    test(`${source} admission rejects a cancellation snapshot`, () => {
      const f =
        source === "shared"
          ? sharedResolutionFixture()
          : resolutionFixture(source);
      setTag(f.decision, prefix + "cancel_kind", kind);
      assert.throws(() => inspect(f), /cancellation/u);
    });

test("cache admission needs no new SQL and preserves raw evidence", () => {
  const f = resolutionFixture();
  const original = JSON.stringify(f.trace);
  assert.deepEqual(inspect(f), {
    trace_id: f.trace.traceID,
    decision_span_id: "decision",
    root_span_id: "root",
    source: "cache",
    profile: "workspace",
    outcome: "admitted",
    admission: true,
    database_spans: 0,
  });
  assert.equal(JSON.stringify(f.trace), original);
});

for (const [name, mutate, reason] of [
  ["missing marker", (f) => f.trace.spans.splice(1, 1), /decision/u],
  ["missing root", (f) => f.trace.spans.splice(0, 1), /parent/u],
  [
    "wrong parent",
    (f) => (f.decision.references[0].spanID = "upstream"),
    /root/u,
  ],
  [
    "non-request root",
    (f) => setTag(f.root, "span.kind", "internal"),
    /request root/u,
  ],
  [
    "unknown source",
    (f) => setTag(f.decision, prefix + "source", "fallback"),
    /source/u,
  ],
  [
    "wrong profile",
    (f) => setTag(f.decision, prefix + "profile", "console"),
    /profile/u,
  ],
  [
    "rejected",
    (f) => setTag(f.decision, prefix + "outcome", "rejected"),
    /outcome/u,
  ],
  ["late marker", (f) => (f.decision.duration = 20000), /upstream/u],
  [
    "detached unrelated child",
    (f) => (f.upstream.references[0].spanID = "missing"),
    /parent/u,
  ],
  [
    "secret label",
    (f) => setTag(f.decision, prefix + "sid", "private"),
    /attribute/u,
  ],
  [
    "unrelated missing SQL",
    (f) => {
      addResolveRPC(f.trace);
      f.trace.spans.find((s) => s.spanID === "sql").references[0].spanID =
        "missing";
    },
    /parent/u,
  ],
])
  test(`cache rejects ${name}`, () => {
    const f = resolutionFixture();
    mutate(f);
    assert.throws(() => inspect(f), reason);
  });

for (const [field, value] of [
  ["snapshot_age_ms", undefined],
  ["snapshot_age_ms", -1],
  ["snapshot_age_ms", 10000],
  ["proof_age_ms", 10000],
  ["proof_age_ms", "1"],
  ["proof_age_ms", Number.NaN],
  ["valid_for_ms", 0],
  ["valid_for_ms", -1],
  ["valid_for_ms", 8000],
])
  test(`cache rejects invalid ${field}=${value}`, () => {
    const f = resolutionFixture();
    setTag(f.decision, prefix + field, value);
    assert.throws(() => inspect(f), /budget/u);
  });

test("an actual rpc keeps CLIENT -> Identity SERVER -> SQL ownership", () => {
  const f = resolutionFixture("rpc");
  const result = inspect(f);
  assert.equal(result.source, "rpc");
  assert.equal(result.database_spans, 1);
  assert.equal(result.rpc_client_span_id, "resolve-client");
  f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "sql");
  assert.throws(() => inspect(f), /PostgreSQL/u);
});

test("shared admission resolves the exact CLIENT after the original caller ended", () => {
  const f = sharedResolutionFixture();
  addResolveRPC(f.origin.trace, "-other", 1050000);
  const result = inspect(f);
  assert.equal(result.source_trace_id, sourceID);
  assert.equal(result.rpc_client_span_id, "resolve-client");
  assert.equal(result.database_spans, 1);
  // A second successful Resolve in the same source cannot supply the target's SQL.
  f.origin.trace.spans = f.origin.trace.spans.filter((s) => s.spanID !== "sql");
  assert.throws(() => inspect(f), /PostgreSQL/u);
});

for (const [name, mutate, reason] of [
  ["missing source", (f) => f.traces.delete(sourceID), /source trace/u],
  [
    "unarchived source",
    (f) => f.archivedTraceIDs.delete(sourceID),
    /archived/u,
  ],
  [
    "wrong target",
    (f) => (f.decision.references[1].spanID = "resolve-server"),
    /CLIENT/u,
  ],
  ["missing link", (f) => f.decision.references.pop(), /link/u],
  [
    "duplicate link",
    (f) => f.decision.references.push({ ...f.decision.references[1] }),
    /link/u,
  ],
  [
    "missing source parent",
    (f) =>
      (f.origin.trace.spans.find(
        (s) => s.spanID === "resolve-client",
      ).references[0].spanID = "missing"),
    /parent/u,
  ],
  [
    "wrong method",
    (f) =>
      setTag(
        f.origin.trace.spans.find((s) => s.spanID === "resolve-client"),
        "http.request.method",
        "GET",
      ),
    /method/u,
  ],
  [
    "wrong source profile",
    (f) => setTag(f.origin.decision, prefix + "profile", "acp"),
    /profile/u,
  ],
  [
    "unfinished source",
    (f) =>
      (f.origin.trace.spans.find(
        (s) => s.spanID === "resolve-client",
      ).duration = 50000),
    /completion/u,
  ],
])
  test(`shared rejects ${name}`, () => {
    const f = sharedResolutionFixture();
    mutate(f);
    assert.throws(() => inspect(f), reason);
  });

test("background shared source requires its archived cache-hit trigger", () => {
  const f = sharedResolutionFixture(true);
  assert.equal(inspect(f).source_root, "background-refresh");
  f.archivedTraceIDs.delete(triggerID);
  assert.throws(() => inspect(f), /archived/u);
});

test("shared source must still be within the configured cache lifetime when the waiter begins", () => {
  const f = sharedResolutionFixture();
  for (const span of f.trace.spans) span.startTime += 11000000;
  assert.throws(() => inspect(f), /budget/u);
});

test("TTL zero cannot produce a shared admission", () => {
  const f = sharedResolutionFixture();
  f.expected.ttlMs = 0;
  assert.throws(() => inspect(f), /budget/u);
});

test("sub-microsecond TTL cannot borrow a fixed timing tolerance", () => {
  const f = resolutionFixture();
  f.expected.ttlMs = 0.000001;
  setTag(f.decision, prefix + "snapshot_age_ms", 0);
  setTag(f.decision, prefix + "proof_age_ms", 0);
  setTag(f.decision, prefix + "valid_for_ms", 0.0005);
  assert.throws(() => inspect(f), /budget/u);
});

test("a rejected original rpc decision cannot supply an admitted shared result", () => {
  const f = sharedResolutionFixture();
  setTag(f.origin.decision, prefix + "outcome", "rejected");
  assert.throws(() => inspect(f), /outcome/u);
});

test("controlled content-capture fixtures must explicitly opt in for request, source and trigger", () => {
  for (const f of [
    resolutionFixture("rpc"),
    sharedResolutionFixture(),
    sharedResolutionFixture(true),
  ]) {
    const source = f.traces.get(triggerID) ?? f.origin?.trace ?? f.trace;
    const server =
      source.spans.find((s) => s.spanID === "resolve-server") ??
      addResolveRPC(source, "", source.spans[0].startTime + 30000).server;
    server.logs = [
      {
        fields: [{ key: "antnest.payload.json", value: '{"fixture":true}' }],
      },
    ];
    assert.throws(() => inspect(f), /capture=false/u);
    f.captureRpcContent = true;
    assert.equal(inspect(f).admission, true);
  }
});

for (const [name, mutate] of [
  ["missing trigger", (f) => (f.origin.root.references = [])],
  ["wrong trigger", (f) => (f.origin.root.references[0].spanID = "upstream")],
  [
    "wrong profile",
    (f) => setTag(f.origin.root, prefix + "profile", "console"),
  ],
  [
    "invented HTTP parent",
    (f) =>
      f.origin.root.references.push({
        refType: "CHILD_OF",
        traceID: sourceID,
        spanID: "missing",
      }),
  ],
])
  test(`background rejects ${name}`, () => {
    const f = sharedResolutionFixture(true);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("cancelled-before-client is diagnostic evidence and never an admission", () => {
  const f = resolutionFixture("shared");
  f.trace.spans = f.trace.spans.filter((s) => s !== f.upstream);
  delete f.expected.upstreamSpanID;
  f.expected.outcome = "unavailable";
  setTag(f.decision, prefix + "outcome", "unavailable");
  setTag(f.decision, prefix + "shared_source_state", "cancelled-before-client");
  setTag(f.decision, prefix + "cancel_kind", "caller-cancelled");
  f.cancellation = {
    traceID: f.trace.traceID,
    decisionSpanID: "decision",
    kind: "caller-cancelled",
    observedAt: 1014000,
  };
  assert.equal(inspect(f).admission, false);
  const valid = structuredClone(f);
  for (const mutate of [
    (f) => delete f.cancellation,
    (f) => (f.cancellation.kind = "shared-deadline"),
    (f) => (f.cancellation.observedAt = 1016000),
    (f) => setTag(f.decision, prefix + "cancel_kind", "unknown"),
    (f) => setTag(f.decision, prefix + "outcome", "admitted"),
    (f) => setTag(f.decision, prefix + "outcome", "rejected"),
    (f) => f.trace.spans.push(f.upstream),
    (f) => {
      const intermediate = structuredClone(f.upstream);
      intermediate.spanID = "intermediate";
      intermediate.startTime = f.decision.startTime + 1;
      setTag(intermediate, "span.kind", "internal");
      f.upstream.references[0].spanID = intermediate.spanID;
      f.trace.spans.push(intermediate, f.upstream);
    },
    (f) => (f.expected.outcome = "admitted"),
    (f) =>
      f.decision.references.push({
        refType: "FOLLOWS_FROM",
        traceID: sourceID,
        spanID: "resolve-client",
      }),
    (f) => (f.decision.references[0].spanID = "missing"),
  ]) {
    const f = structuredClone(valid);
    mutate(f);
    assert.throws(() => inspect(f));
  }
});
