import assert from "node:assert/strict";
import test from "node:test";
import { inspectWorkspaceWatch } from "./current-trace.mjs";
import {
  workspaceWatchFixture,
  revokedWatchFixture,
} from "./watch-fixtures.mjs";
import {
  sharedResolutionFixture,
  setTag,
  sourceID,
  triggerID,
  resolvePrefix as prefix,
} from "../observability/gateway-resolution-fixtures.mjs";

const byID = (trace, id) => trace.spans.find((span) => span.spanID === id);
const inspect = (f) =>
  inspectWorkspaceWatch(f.trace, f.expected, ["PRIVATE"], f);

function fixture(source = "rpc", background = false) {
  const f = workspaceWatchFixture();
  f.decision = byID(f.trace, "decision");
  f.traces = new Map([[f.trace.traceID, f.trace]]);
  f.archivedTraceIDs = new Set([f.trace.traceID]);
  if (source !== "rpc")
    f.trace.spans = f.trace.spans.filter(
      (span) =>
        !["identity-client", "identity", "identity-db"].includes(span.spanID),
    );
  setTag(f.decision, prefix + "source", source);
  if (source === "cache")
    for (const [key, value] of Object.entries({
      snapshot_age_ms: 2000,
      proof_age_ms: 100,
      valid_for_ms: 8000,
    }))
      setTag(f.decision, prefix + key, value);
  if (source === "shared") {
    const shared = sharedResolutionFixture(background);
    for (const [id, trace] of shared.traces) {
      if (id === f.trace.traceID) continue;
      for (const span of trace.spans) {
        span.startTime = 1000000 + (span.startTime - 1000000) / 10;
        span.duration /= 10;
      }
      f.traces.set(id, trace);
      f.archivedTraceIDs.add(id);
    }
    f.decision.references.push({
      refType: "FOLLOWS_FROM",
      traceID: sourceID,
      spanID: "resolve-client",
    });
    setTag(f.decision, prefix + "shared_source_state", "actual-client");
  }
  return f;
}

for (const [source, background, checks] of [
  ["rpc", false, 1],
  ["cache", false, 0],
  ["shared", false, 1],
  ["shared", true, 1],
])
  test(`state watch verifies ${source} admission with background=${background}`, () => {
    const f = fixture(source, background);
    const before = JSON.stringify([...f.traces.values()]);
    const result = inspect(f);
    assert.equal(result.gateway_resolution.source, source);
    assert.equal(result.gateway_resolution.profile, "workspace");
    assert.equal(result.identity_checks, checks);
    assert.equal(result.identity_sql, checks);
    assert.equal(result.stop_window_verified, true);
    assert.equal(JSON.stringify([...f.traces.values()]), before);
  });

for (const [name, mutate] of [
  [
    "missing decision",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.decision), 1),
  ],
  [
    "duplicate initial decision",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.decision),
        spanID: "duplicate",
      }),
  ],
  ["wrong profile", (f) => setTag(f.decision, prefix + "profile", "acp")],
  [
    "wrong decision parent",
    (f) => (f.decision.references[0].spanID = "acp-client"),
  ],
  ["late admission", (f) => (f.decision.duration = 2500)],
  ["expired cache", (f) => setTag(f.decision, prefix + "valid_for_ms", 0)],
  ["missing source archive", (f) => f.archivedTraceIDs.delete(sourceID)],
  ["missing source SQL", (f) => f.traces.get(sourceID).spans.pop()],
  ["source credential", (f) => (f.traces.get(sourceID).private = "PRIVATE")],
  [
    "source SQL error",
    (f) => setTag(byID(f.traces.get(sourceID), "sql"), "error", true),
  ],
  [
    "missing source parent",
    (f) =>
      (f.traces.get(sourceID).spans = f.traces
        .get(sourceID)
        .spans.filter((s) => s.spanID !== "root")),
  ],
  [
    "wrong refresh trigger profile",
    (f) =>
      setTag(
        byID(f.traces.get(triggerID), "decision"),
        prefix + "profile",
        "console",
      ),
  ],
])
  test(`state watch rejects ${name}`, () => {
    const f = fixture(name === "expired cache" ? "cache" : "shared", true);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("state watch retains source and trigger warnings as strict failures", () => {
  const f = fixture("shared", true);
  f.traces.get(sourceID).warnings = ["source warning"];
  f.traces.get(triggerID).warnings = ["trigger warning"];
  const result = inspect(f);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.warning_count, 2);
  assert.deepEqual(
    new Set(result.warnings),
    new Set(["source warning", "trigger warning"]),
  );
});

function revalidated() {
  const f = fixture("cache");
  const live = workspaceWatchFixture();
  for (const id of ["identity-client", "identity", "identity-db", "decision"]) {
    const span = structuredClone(byID(live.trace, id));
    span.spanID += "-later";
    for (const ref of span.references)
      if (ref.spanID !== "root") ref.spanID += "-later";
    span.startTime += 2000;
    f.trace.spans.push(span);
  }
  return f;
}

test("every admitted revalidation requires its actual receiving SERVER and SQL", () => {
  const f = revalidated();
  const result = inspect(f);
  assert.equal(result.gateway_revalidations.length, 1);
  assert.equal(result.identity_checks, 1);
  assert.equal(result.identity_sql, 1);
  for (const id of ["identity-later", "identity-db-later"]) {
    const missing = revalidated();
    missing.trace.spans = missing.trace.spans.filter((s) => s.spanID !== id);
    assert.throws(() => inspect(missing));
  }
});

test("a later valid Resolve cannot replace missing initial admission", () => {
  const f = revalidated();
  f.trace.spans = f.trace.spans.filter((s) => s !== f.decision);
  assert.throws(() => inspect(f));
});

test("two rpc creators cannot claim the same actual revalidation CLIENT", () => {
  const f = revalidated();
  const duplicate = structuredClone(byID(f.trace, "decision-later"));
  duplicate.spanID = "duplicate-rpc-creator";
  f.trace.spans.push(duplicate);
  assert.throws(() => inspect(f), /multiple rpc decisions claim one CLIENT/u);
});

test("shared revalidations retain one SQL owner for their same actual source", () => {
  const f = fixture("shared", true);
  const later = structuredClone(f.decision);
  later.spanID = "shared-later";
  later.startTime = 1002300;
  later.duration = 500;
  f.trace.spans.push(later);
  const result = inspect(f);
  assert.equal(result.gateway_revalidations.length, 1);
  assert.equal(result.identity_checks, 1);
  assert.equal(result.identity_sql, 1);
});

function sharedRejected(background = false) {
  const f = revokedWatchFixture();
  const origin = structuredClone(f.trace);
  origin.traceID = sourceID;
  for (const span of origin.spans) {
    span.traceID = sourceID;
    for (const ref of span.references) ref.traceID = sourceID;
  }
  f.trace.spans = f.trace.spans.filter(
    (s) => !["denied-client", "denied", "denied-sql"].includes(s.spanID),
  );
  const decision = byID(f.trace, "denied-decision");
  setTag(decision, prefix + "source", "shared");
  setTag(decision, prefix + "shared_source_state", "actual-client");
  decision.references.push({
    refType: "FOLLOWS_FROM",
    traceID: sourceID,
    spanID: "denied-client",
  });
  f.traces = new Map([
    [f.trace.traceID, f.trace],
    [sourceID, origin],
  ]);
  f.archivedTraceIDs = new Set(f.traces.keys());
  if (background) {
    const shared = fixture("shared", true);
    const root = byID(origin, "root");
    root.operationName = "gateway.identity.resolve.refresh";
    root.startTime = decision.startTime;
    root.duration = decision.duration;
    root.tags = [];
    for (const [key, value] of Object.entries({
      "span.kind": "internal",
      [prefix + "profile"]: "workspace",
      [prefix + "outcome"]: "rejected",
      error: true,
      "otel.status_description": "rejected",
    }))
      setTag(root, key, value);
    root.references = [
      { refType: "FOLLOWS_FROM", traceID: triggerID, spanID: "decision" },
    ];
    origin.spans = origin.spans.filter((s) =>
      ["root", "denied-client", "denied", "denied-sql"].includes(s.spanID),
    );
    f.traces.set(triggerID, shared.traces.get(triggerID));
    f.archivedTraceIDs.add(triggerID);
  }
  return f;
}

for (const background of [false, true])
  test(`state watch binds shared rejection to actual 401 SQL with background=${background}`, () => {
    const f = sharedRejected(background);
    const result = inspect(f);
    assert.equal(result.revocation_verified, true);
    assert.equal(result.gateway_revalidations[0].outcome, "rejected");
    assert.equal(result.identity_checks, 2);
    assert.equal(result.identity_sql, 2);
    assert.equal(result.strict_trace, "failed");
  });

for (const background of [false, true])
  test(`shared denial rejects unknown source diagnostics with background=${background}`, () => {
    const f = sharedRejected(background);
    setTag(
      byID(f.traces.get(sourceID), "root"),
      prefix + "unknown",
      "unreviewed",
    );
    assert.throws(() => inspect(f), /unknown Resolve diagnostic attribute/u);
  });

for (const [name, mutate] of [
  ["missing link", (f) => byID(f.trace, "denied-decision").references.pop()],
  [
    "wrong link",
    (f) =>
      (byID(f.trace, "denied-decision").references.at(-1).spanID =
        "identity-client"),
  ],
  ["missing denied SQL", (f) => f.traces.get(sourceID).spans.pop()],
  [
    "missing marker error",
    (f) => setTag(byID(f.trace, "denied-decision"), "error", undefined),
  ],
  [
    "wrong error description",
    (f) =>
      setTag(
        byID(f.trace, "denied-decision"),
        "otel.status_description",
        "unavailable",
      ),
  ],
  ["undeclared revocation", (f) => delete f.expected.revoked],
  [
    "unavailable disguised as revocation",
    (f) =>
      setTag(
        byID(f.trace, "denied-decision"),
        prefix + "outcome",
        "unavailable",
      ),
  ],
  ["outside stop window", (f) => (f.expected.stopWindow.start = 2000)],
  [
    "unrelated 503",
    (f) =>
      setTag(
        byID(f.traces.get(sourceID), "denied"),
        "http.response.status_code",
        503,
      ),
  ],
])
  test(`shared watch rejection rejects ${name}`, () => {
    const f = sharedRejected(true);
    mutate(f);
    assert.throws(() => inspect(f));
  });
