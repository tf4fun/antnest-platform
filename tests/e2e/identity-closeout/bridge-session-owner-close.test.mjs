import assert from "node:assert/strict";
import test from "node:test";
import { inspectBridgeSessionOwnerClose } from "./bridge-session-owner-close.mjs";
import { sessionOwnerFixture } from "./bridge-session-owner-fixtures.mjs";
import { inspectBridgeSessionBoundary } from "./bridge-session-trace.mjs";
import { inspectBridgeSessionClosure } from "./bridge-session-cause.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const inspect = (f) =>
  inspectBridgeSessionOwnerClose(f.context, f.collection, []);
const closeTag = (f, key, value) =>
  setTag(f.close, "antnest.ui.acp.close." + key, value);

for (const location of ["tag", "event"])
  for (const [key, value] of [
    ...["http.response.status_code", "http.status_code"].flatMap((key) =>
      [503, "503", "0202", 200].map((value) => [key, value]),
    ),
    ...["ERROR", "WARN", "FATAL"].map((value) => ["level", value]),
  ])
    test(`owner rejects unowned DELETE ${location} ${key}=${JSON.stringify(value)}`, () => {
      const f = sessionOwnerFixture();
      inspect(f);
      if (location === "tag") setTag(f.deletion, key, value);
      else
        (f.deletion.logs ??= []).push({
          timestamp: f.deletion.startTime + 1,
          fields: [{ key, value }],
        });
      f.syncSearches();
      const before = JSON.stringify([...f.collection.traces]);
      assert.throws(() => inspect(f));
      assert.equal(JSON.stringify([...f.collection.traces]), before);
    });

for (const [key, value] of [
  ...["http.response.status_code", "http.status_code"].flatMap((key) =>
    [202, "202"].map((value) => [key, value]),
  ),
  ...["TRACE", "DEBUG", "INFO"].map((value) => ["level", value]),
])
  test(`owner preserves successful DELETE event ${key}=${JSON.stringify(value)}`, () => {
    const f = sessionOwnerFixture();
    (f.deletion.logs ??= []).push({
      timestamp: f.deletion.startTime + 1,
      fields: [{ key, value }],
    });
    f.syncSearches();
    const before = JSON.stringify([...f.collection.traces]);
    assert.equal(inspect(f).owners.length, 1);
    assert.equal(JSON.stringify([...f.collection.traces]), before);
  });

test("Session cause validates actual owner evidence before classifying each private stream", () => {
  const f = sessionOwnerFixture();
  f.collection.sessionOwnerContext = f.context;
  for (const expected of f.context.closures) {
    const result = inspectBridgeSessionClosure(
      f.collection.traces.get(expected.traceID),
      expected,
      [],
      f.collection,
    );
    assert.equal(result.authorizationCauseVerified, true);
    assert.equal(result.owner_close.owners.length, 1);
    assert.equal(result.owner_close.classified_errors.length, 3);
    assert.equal(result.strict_trace, "failed");
  }
});

test("an external owner result cannot authorize private Session diagnostics", () => {
  const f = sessionOwnerFixture();
  f.collection.ownerProof = { passed: true, nodes: f.streams };
  assert.throws(
    () =>
      inspectBridgeSessionClosure(
        f.first.trace,
        f.first.expected,
        [],
        f.collection,
      ),
    /owner/u,
  );
});

test("Session cause reruns close validation instead of trusting previously classified nodes", () => {
  const f = sessionOwnerFixture();
  f.collection.sessionOwnerContext = f.context;
  f.collection.ownerProof = inspect(f);
  setTag(f.deletion, "http.response.status_code", 503);
  f.syncSearches();
  assert.throws(
    () =>
      inspectBridgeSessionClosure(
        f.first.trace,
        f.first.expected,
        [],
        f.collection,
      ),
    /status/u,
  );
});

test("owner context cannot substitute another observation for the current Session cause", () => {
  const f = sessionOwnerFixture();
  f.collection.sessionOwnerContext = structuredClone(f.context);
  f.collection.sessionOwnerContext.closures[0].denial.intentId =
    "00000000-0000-4000-8000-000000000099";
  assert.throws(
    () =>
      inspectBridgeSessionClosure(
        f.first.trace,
        f.first.expected,
        [],
        f.collection,
      ),
    /observation/u,
  );
});

test("owner fixtures retain both original Session boundaries", () => {
  const f = sessionOwnerFixture();
  for (const expected of f.context.closures)
    inspectBridgeSessionBoundary(
      f.collection.traces.get(expected.traceID),
      expected,
      [],
      f.collection,
    );
});

test("distinct Cookies and Sessions share one actual owner and preserve the later GET parent", () => {
  const f = sessionOwnerFixture();
  const before = JSON.stringify([...f.collection.traces]);
  const result = inspect(f);
  assert.equal(result.owners.length, 1);
  const [owner] = result.owners;
  assert.deepEqual(owner.scope, {
    organization_id: "org",
    user_id: "user",
    agent_id: "agent-1",
  });
  assert.equal(owner.initial_trace_id, f.first.trace.traceID);
  assert.equal(owner.initial_ui_span_id, f.first.ui.spanID);
  assert.equal(owner.initialize_span_id, f.initialize.spanID);
  assert.equal(owner.close_trace_id, f.closing.traceID);
  assert.equal(owner.delete_span_id, f.deletion.spanID);
  assert.equal(owner.streams.length, 3);
  assert.equal(
    owner.streams.find((row) => row.trace_id === f.second.trace.traceID)
      .ui_span_id,
    f.second.ui.spanID,
  );
  assert.equal(result.classified_errors.length, 3);
  assert(
    result.nodes.some(
      (row) => row.trace === f.second.trace && row.span === f.streams[1],
    ),
  );
  assert.equal(JSON.stringify([...f.collection.traces]), before);
});

test("successful private streams remain in the complete owner inventory", () => {
  const f = sessionOwnerFixture();
  for (const key of [
    "error",
    "otel.status_code",
    "error.type",
    "antnest.outcome",
  ])
    setTag(f.watch, key, undefined);
  const result = inspect(f);
  assert.equal(result.owners[0].streams.length, 3);
  assert.equal(result.classified_errors.length, 2);
});

const withoutLaterPrivateWork = (f) => {
  f.second.trace.spans.splice(f.second.trace.spans.indexOf(f.streams[1]), 1);
};

test("a later SSE without new private work still belongs to its actual owner", () => {
  const f = sessionOwnerFixture();
  withoutLaterPrivateWork(f);
  const result = inspect(f);
  assert.equal(result.owners.length, 1);
  assert.deepEqual(result.owners[0].observations, [
    { trace_id: f.first.trace.traceID, ui_span_id: f.first.ui.spanID },
    { trace_id: f.second.trace.traceID, ui_span_id: f.second.ui.spanID },
  ]);
  assert.equal(result.owners[0].streams.length, 2);
});

for (const [name, change] of [
  [
    "Principal",
    (f) => (f.context.closures[1].principal.user_id = "foreign-user"),
  ],
  [
    "UI process",
    (f) =>
      setTag(f.second.trace.processes.ui, "service.instance.id", "foreign-ui"),
  ],
])
  test(`a later SSE without private work cannot borrow another ${name}`, () => {
    const f = sessionOwnerFixture();
    withoutLaterPrivateWork(f);
    change(f);
    assert.throws(() => inspect(f), /owner|process/u);
  });

for (const failed of [false, true])
  for (const kind of ["GET", "watch"])
    test(`${failed ? "interrupted" : "successful"} ${kind} rejects an extra failed operation phase`, () => {
      const f = sessionOwnerFixture();
      const span = kind === "GET" ? f.streams[1] : f.watch;
      if (!failed)
        for (const key of [
          "error",
          "otel.status_code",
          "error.type",
          "antnest.outcome",
        ])
          setTag(span, key, undefined);
      setTag(span, "antnest.operation.phase", "failed");
      assert.throws(() => inspect(f), /diagnostic/u);
    });

for (const [name, change, message] of [
  ["missing initialization Link", (f) => (f.close.references = []), /Link/u],
  [
    "Link to later warm UI",
    (f) => {
      f.close.references[0].traceID = f.second.trace.traceID;
      f.close.references[0].spanID = f.second.ui.spanID;
    },
    /initialization/u,
  ],
  [
    "conflicting Link",
    (f) => f.close.references.push({ ...f.close.references[0] }),
    /Link/u,
  ],
  [
    "synchronous close parent",
    (f) => (f.close.references[0].refType = "CHILD_OF"),
    /parent|root/u,
  ],
  [
    "different Principal",
    (f) => (f.context.closures[1].principal.user_id = "another-user"),
    /owner|Principal/u,
  ],
  [
    "different Agent",
    (f) => setTag(f.initialize, "antnest.agent.id", "other-agent"),
    /agent/u,
  ],
  [
    "different UI process",
    (f) => setTag(f.closing.processes.ui, "service.instance.id", "other-ui"),
    /process/u,
  ],
  [
    "different ACP process",
    (f) =>
      setTag(f.second.trace.processes.acp, "service.instance.id", "other-acp"),
    /process|instance/u,
  ],
  [
    "GET under wrong UI",
    (f) => (f.streams[1].references[0].spanID = f.second.upstream.spanID),
    /parent|origin/u,
  ],
  [
    "missing DELETE",
    (f) => f.closing.spans.splice(f.closing.spans.indexOf(f.deletion), 1),
    /DELETE/u,
  ],
  [
    "duplicate DELETE",
    (f) =>
      f.closing.spans.push({
        ...structuredClone(f.deletion),
        spanID: "0".repeat(16),
      }),
    /DELETE/u,
  ],
  [
    "failed DELETE",
    (f) => setTag(f.deletion, "http.response.status_code", 503),
    /status/u,
  ],
  [
    "missing response completion",
    (f) => closeTag(f, "delete_completed", 0),
    /receipt/u,
  ],
  ["pending request", (f) => closeTag(f, "pending_requests", 1), /receipt/u],
  ["unjoined stream", (f) => closeTag(f, "stream_joined", false), /receipt/u],
  ["failed close", (f) => closeTag(f, "outcome", "failed"), /receipt/u],
  ["no close target", (f) => closeTag(f, "outcome", "no_target"), /receipt/u],
  ["extra close diagnostic", (f) => closeTag(f, "unknown", true), /receipt/u],
  [
    "failed private HTTP transport",
    (f) => setTag(f.watch, "http.transport.error.type", "unexpected"),
    /diagnostic/u,
  ],
  [
    "private RPC failure",
    (f) => setTag(f.watch, "rpc.response.status_code", -32000),
    /status/u,
  ],
  [
    "unknown private event",
    (f) => (f.watch.events = [{ name: "unknown" }]),
    /event/u,
  ],
  ["unfinished private stream", (f) => (f.watch.duration = -1), /unfinished/u],
  [
    "private stream after actual stop",
    (f) => (f.watch.duration += 1000000),
    /stop/u,
  ],
  [
    "DELETE before actual stop",
    (f) => (f.deletion.startTime -= 1000000),
    /stop/u,
  ],
  [
    "missing successful watch",
    (f) => f.first.trace.spans.splice(f.first.trace.spans.indexOf(f.watch), 1),
    /watch/u,
  ],
  [
    "orphan private stream",
    (f) =>
      f.second.trace.spans.push({
        ...structuredClone(f.streams[1]),
        spanID: "0".repeat(16),
        references: [],
      }),
    /detached|root|owner/u,
  ],
  [
    "unarchived initialization",
    (f) => f.collection.archivedTraceIDs.delete(f.first.trace.traceID),
    /archived/u,
  ],
  [
    "unarchived cleanup",
    (f) => f.collection.archivedTraceIDs.delete(f.closing.traceID),
    /archived/u,
  ],
  [
    "clock from another container",
    (f) => (f.context.ownerLifecycle.acp_clock.container_id = "f".repeat(64)),
    /container/u,
  ],
  [
    "clock after stop",
    (f) => (f.context.ownerLifecycle.acp_clock.received_at = 7600),
    /clock/u,
  ],
  [
    "clock before baseline",
    (f) => (f.context.ownerLifecycle.acp_clock.started_at = 5800),
    /clock/u,
  ],
  [
    "ACP restarted during stop",
    (f) =>
      (f.context.ownerLifecycle.after["agent-acp-service"].started_at =
        new Date().toISOString()),
    /process/u,
  ],
  [
    "health from another process",
    (f) =>
      setTag(f.health.processes.acp, "service.instance.id", "foreign-health"),
    /process|instance/u,
  ],
  [
    "health with synthetic parent",
    (f) =>
      (f.health.spans[0].references = [
        {
          refType: "FOLLOWS_FROM",
          traceID: f.first.trace.traceID,
          spanID: f.initialize.spanID,
        },
      ]),
    /parent|link/u,
  ],
])
  test(`Session owner rejects ${name}`, () => {
    const f = sessionOwnerFixture();
    change(f);
    f.syncSearches();
    assert.throws(() => inspect(f), message);
  });

for (const [name, change, message] of [
  [
    "one-sided close search failure",
    (f) => f.collection.cleanupSearches.errors.push(new Error("failed")),
    /search/u,
  ],
  [
    "late fourth close snapshot",
    (f) => f.collection.cleanupSearches.rounds.close.push([]),
    /converge/u,
  ],
  [
    "raw snapshot changed",
    (f) =>
      (f.collection.cleanupSearches.rounds.deletion[1][0].spans[0].duration += 1),
    /converge/u,
  ],
  [
    "incomplete health search",
    (f) => f.collection.healthSearches.rounds.pop(),
    /health/u,
  ],
  [
    "health search failure",
    (f) => f.collection.healthSearches.errors.push(new Error("failed")),
    /health/u,
  ],
  [
    "unarchived health",
    (f) => f.collection.archivedTraceIDs.delete(f.health.traceID),
    /archived/u,
  ],
  [
    "health inventory mismatch",
    (f) => (f.collection.healthSearches.found = []),
    /health/u,
  ],
])
  test(`Session owner rejects ${name}`, () => {
    const f = sessionOwnerFixture();
    change(f);
    assert.throws(() => inspect(f), message);
  });
