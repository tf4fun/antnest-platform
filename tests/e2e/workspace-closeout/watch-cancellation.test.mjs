import assert from "node:assert/strict";
import test from "node:test";
import { inspectWorkspaceWatch } from "./current-trace.mjs";
import {
  workspaceWatchFixture,
  feedClosedWatchFixture,
} from "./watch-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";
import {
  setTag,
  sharedResolutionFixture,
  sourceID,
  triggerID,
  resolvePrefix as prefix,
} from "../observability/gateway-resolution-fixtures.mjs";

const byID = (trace, id) => trace.spans.find((span) => span.spanID === id);
const inspect = (f) => inspectWorkspaceWatch(f.trace, f.expected, [], f);
function fixture(source = "rpc", completion = "cancelled", background = false) {
  const f = workspaceWatchFixture();
  f.traces = new Map([[f.trace.traceID, f.trace]]);
  f.archivedTraceIDs = new Set([f.trace.traceID]);
  f.expected.closure = {
    traceID: f.trace.traceID,
    kind: "local-close",
    observedAt: 1003,
  };
  for (const [key, value] of Object.entries({
    error: true,
    "otel.status_description": "handler_aborted",
    "antnest.http.request_cancelled": true,
  }))
    setTag(byID(f.trace, "root"), key, value);
  setTag(byID(f.trace, "acp-client"), "error", true);
  setTag(byID(f.trace, "acp-client"), "error.type", "cancelled");
  setTag(byID(f.trace, "acp"), "error", true);
  setTag(byID(f.trace, "acp"), "error.type", "stream_interrupted");
  f.decision = structuredClone(byID(f.trace, "decision"));
  f.decision.spanID = "cancelled-decision";
  f.decision.startTime = 1002400;
  f.decision.duration = 1000;
  for (const [key, value] of Object.entries({
    [prefix + "source"]: source,
    [prefix + "outcome"]: "unavailable",
    error: true,
    "otel.status_description": "unavailable",
  }))
    setTag(f.decision, key, value);
  f.trace.spans.push(f.decision);
  if (source === "shared") {
    setTag(f.decision, prefix + "cancel_kind", "caller-cancelled");
    setTag(
      f.decision,
      prefix + "shared_source_state",
      completion === "before-client"
        ? "cancelled-before-client"
        : "actual-client",
    );
    if (completion === "before-client") return f;
  }
  const client = structuredClone(byID(f.trace, "identity-client"));
  client.spanID = "pending-client";
  client.startTime = 1002500;
  client.duration = 3000; // Owned work can outlive the cancelling watch root.
  const server = structuredClone(byID(f.trace, "identity"));
  server.spanID = "pending-server";
  server.references[0].spanID = client.spanID;
  server.startTime = client.startTime + 100;
  const sql = structuredClone(byID(f.trace, "identity-db"));
  sql.spanID = "pending-sql";
  sql.references[0].spanID = server.spanID;
  sql.startTime = server.startTime + 1;
  const work = [client];
  if (completion === "cancelled") {
    setTag(client, "http.response.status_code", undefined);
    setTag(client, "error", true);
    setTag(client, "error.type", "cancelled");
    setTag(client, "otel.status_description", "Request was cancelled");
    client.logs = [
      {
        fields: fields({
          event: "antnest.error",
          "antnest.error.stage": "send",
        }),
      },
    ];
  } else {
    work.push(server, sql);
    if (completion === "rejected") {
      f.expected.revoked = true;
      f.expected.revocationTraceID = "d".repeat(32);
      f.expected.closure.kind = "access-denied";
      f.expected.states = [{ access_allowed: false }];
      for (const span of [client, server]) {
        setTag(span, "http.response.status_code", 401);
        setTag(span, "error", true);
      }
      setTag(client, "error.type", "401");
      setTag(server, "error.type", "unauthenticated");
    }
  }
  if (source === "rpc") f.trace.spans.push(...work);
  else {
    f.decision.references.push({
      refType: "FOLLOWS_FROM",
      traceID: sourceID,
      spanID: client.spanID,
    });
    const root = structuredClone(byID(f.trace, "root"));
    root.startTime = 1002000;
    root.duration = 1000;
    const origin = structuredClone(f.decision);
    origin.spanID = "origin";
    origin.duration = 300;
    origin.tags = fields({
      "span.kind": "internal",
      [prefix + "source"]: "rpc",
      [prefix + "profile"]: "workspace",
      [prefix + "outcome"]: "unavailable",
      error: true,
      "otel.status_description": "unavailable",
    });
    origin.references = [
      { refType: "CHILD_OF", traceID: sourceID, spanID: "root" },
    ];
    const trace = {
      traceID: sourceID,
      processes: f.trace.processes,
      spans: [root, origin, ...work],
    };
    if (background) {
      root.operationName = "gateway.identity.resolve.refresh";
      root.startTime = 1002400;
      root.duration = 4000;
      const outcome =
        completion === "success"
          ? "admitted"
          : completion === "rejected"
            ? "rejected"
            : "unavailable";
      root.tags = fields({
        "span.kind": "internal",
        [prefix + "profile"]: "workspace",
        [prefix + "outcome"]: outcome,
        ...(outcome !== "admitted"
          ? { error: true, "otel.status_description": outcome }
          : {}),
      });
      root.references = [
        { refType: "FOLLOWS_FROM", traceID: triggerID, spanID: "decision" },
      ];
      trace.spans = trace.spans.filter((s) => s !== origin);
      const trigger = sharedResolutionFixture(true).traces.get(triggerID);
      f.traces.set(triggerID, trigger);
      f.archivedTraceIDs.add(triggerID);
    }
    for (const span of trace.spans) {
      span.traceID = sourceID;
      for (const ref of span.references)
        if (ref.refType === "CHILD_OF") ref.traceID = sourceID;
    }
    f.traces.set(sourceID, trace);
    f.archivedTraceIDs.add(sourceID);
  }
  return f;
}

for (const [source, completion, background] of [
  ["rpc", "cancelled", false],
  ["rpc", "success", false],
  ["shared", "before-client", false],
  ["shared", "cancelled", false],
  ["shared", "success", false],
  ["shared", "success", true],
  ["shared", "rejected", true],
  ["shared", "cancelled", true],
])
  test(`watch cancellation binds ${source}/${completion}/background=${background} to independent closure`, () => {
    const f = fixture(source, completion, background);
    const before = JSON.stringify([...f.traces.values()]);
    const result = inspect(f);
    assert.equal(result.gateway_resolution.admission, true);
    assert.equal(result.gateway_revalidations[0].admission, false);
    assert.equal(result.gateway_revalidations[0].cancellation_verified, true);
    assert.equal(result.revocation_verified, false);
    assert.equal(
      result.identity_sql,
      ["success", "rejected"].includes(completion) ? 2 : 1,
    );
    assert.equal(result.strict_trace, "failed");
    assert.equal(JSON.stringify([...f.traces.values()]), before);
  });

for (const [name, mutate] of [
  ["missing closure witness", (f) => delete f.expected.closure],
  ["wrong closure trace", (f) => (f.expected.closure.traceID = sourceID)],
  ["unrelated global abort", (f) => (f.expected.closure.kind = "aborted")],
  [
    "unobserved access loss",
    (f) => (f.expected.closure.kind = "access-denied"),
  ],
  [
    "unclassified transport failure",
    (f) => (f.expected.closure.kind = "transport-end"),
  ],
  ["outside stop window", (f) => (f.expected.closure.observedAt = 4000)],
  [
    "closure after pending check",
    (f) => (f.expected.closure.observedAt = 2000),
  ],
  [
    "missing request cancellation",
    (f) =>
      setTag(
        byID(f.trace, "root"),
        "antnest.http.request_cancelled",
        undefined,
      ),
  ],
  [
    "shared deadline",
    (f) => setTag(f.decision, prefix + "cancel_kind", "shared-deadline"),
  ],
  [
    "process shutdown",
    (f) => setTag(f.decision, prefix + "cancel_kind", "process-shutdown"),
  ],
  ["missing actual link", (f) => f.decision.references.pop()],
  [
    "wrong source profile",
    (f) =>
      setTag(byID(f.traces.get(sourceID), "origin"), prefix + "profile", "acp"),
  ],
  [
    "wrong CLIENT cancellation",
    (f) =>
      setTag(
        byID(f.traces.get(sourceID), "pending-client"),
        "error.type",
        "timeout",
      ),
  ],
  [
    "wrong CLIENT failure stage",
    (f) =>
      (byID(f.traces.get(sourceID), "pending-client").logs[0].fields[1].value =
        "unrelated"),
  ],
  [
    "unrelated 503",
    (f) =>
      setTag(
        byID(f.traces.get(sourceID), "pending-client"),
        "http.response.status_code",
        503,
      ),
  ],
  [
    "new upstream after cancellation",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(byID(f.trace, "acp-client")),
        spanID: "late-upstream",
        startTime: 1003500,
      }),
  ],
])
  test(`watch cancellation rejects ${name}`, () => {
    const f = fixture("shared", "cancelled");
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("a continuing source still requires receiving SERVER and SQL after waiter cancellation", () => {
  for (const id of ["pending-server", "pending-sql"]) {
    const f = fixture("shared", "success", true);
    f.traces.get(sourceID).spans = f.traces
      .get(sourceID)
      .spans.filter((s) => s.spanID !== id);
    assert.throws(() => inspect(f));
  }
});
test("rpc without actual CLIENT cannot use a closure witness to hide preflight unavailability", () => {
  const f = fixture("rpc", "cancelled");
  f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "pending-client");
  assert.throws(() => inspect(f));
});

test("cancellation cannot attach an expired shared source from an earlier flight", () => {
  const f = fixture("shared", "cancelled");
  f.expected.resolveTTLMS = 1;
  for (const span of f.traces.get(sourceID).spans) span.startTime -= 3000;
  assert.throws(() => inspect(f), /policy budget/u);
});

for (const background of [false, true])
  test(`actual-client cancellation cannot link a CLIENT created after its snapshot, background=${background}`, () => {
    const f = fixture("shared", "cancelled", background);
    for (const span of f.traces.get(sourceID).spans) span.startTime += 10000;
    assert.throws(() => inspect(f), /created after cancellation snapshot/u);
  });

for (const kind of ["aborted", "invalid-state"])
  test(`watch rejects recorded ${kind} even without pending Resolve`, () => {
    const f = fixture();
    f.trace.spans = f.trace.spans.filter(
      (span) => !["cancelled-decision", "pending-client"].includes(span.spanID),
    );
    f.expected.closure.kind = kind;
    assert.throws(() => inspect(f), /watch observation did not complete/u);
  });

for (const source of ["rpc", "shared"])
  test(`private feed closure proves pending ${source} cancellation without local abort`, () => {
    const f = fixture(source, source === "rpc" ? "cancelled" : "before-client");
    const feed = feedClosedWatchFixture();
    for (const id of ["root", "acp-client", "acp"])
      Object.assign(byID(f.trace, id), byID(feed.trace, id));
    Object.assign(f.expected, {
      revoked: true,
      revocationTraceID: feed.expected.revocationTraceID,
    });
    f.expected.closure.kind = "transport-end";
    if (source === "rpc") {
      f.expected.resolveTTLMS = 0;
      setTag(byID(f.trace, "pending-client"), "error.type", "operation_failed");
      setTag(
        byID(f.trace, "pending-client"),
        "otel.status_description",
        "Operation failed; unclassified error text was not exported",
      );
    }
    const result = inspect(f);
    assert.equal(result.gateway_revalidations[0].cancellation_verified, true);
    assert.equal(result.revocation_verified, false);
    assert.equal(result.strict_trace, "failed");
    if (source === "rpc") {
      f.expected.resolveTTLMS = 10000;
      assert.throws(
        () => inspect(f),
        /unrelated pending Resolve transport failure/u,
      );
    }
    setTag(byID(f.trace, "acp"), "antnest.outcome", undefined);
    assert.throws(() => inspect(f));
  });

test("watch closure cannot waive actual receiver failures or failed SQL", () => {
  for (const status of [500, 503]) {
    const f = fixture("shared", "success");
    setTag(
      byID(f.traces.get(sourceID), "pending-server"),
      "http.response.status_code",
      status,
    );
    assert.throws(
      () => inspect(f),
      /unrelated cancelled Resolve receiver failure/u,
    );
  }
  const f = fixture("shared", "success");
  setTag(byID(f.traces.get(sourceID), "pending-sql"), "error", true);
  assert.throws(() => inspect(f), /failed Resolve SQL/u);
});
