import assert from "node:assert/strict";
import test from "node:test";
import * as implementation from "../edge-gateway/resolve-cache-outage-rejection.mjs";
import {
  sessionRejectionFixture,
  failureDiagnostic,
} from "./session-rejection-trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const ready = () =>
  assert.equal(
    typeof implementation.inspectGatewayIdentityRejection,
    "function",
  );
const inspect = (f) =>
  implementation.inspectGatewayIdentityRejection(
    f.trace,
    f.expected,
    f.collection,
    ["PRIVATE-SESSION-REJECTION-CANARY"],
  );
function foreignGateway(trace, span) {
  const process = structuredClone(trace.processes[span.processID]);
  for (const field of process.tags)
    if (field.key === "host.name") field.value = "another-gateway";
    else if (field.key === "process.pid") field.value = 99;
    else if (field.key === "service.instance.id")
      field.value = "another-instance";
  trace.processes.foreignGateway = process;
  span.processID = "foreignGateway";
}
function triggerOf(f) {
  const reference = f.sourceRoot.references.find(
    (ref) => ref.refType === "FOLLOWS_FROM",
  );
  const trace = f.collection.traces.get(reference.traceID);
  const decision = trace.spans.find((s) => s.spanID === reference.spanID);
  const root = trace.spans.find(
    (s) => s.spanID === decision.references[0].spanID,
  );
  return { trace, decision, root };
}
for (const status of [401, 503])
  for (const [source, background] of [
    ["rpc", false],
    ["shared", false],
    ["shared", true],
  ])
    test(`standalone Bridge POST ${status} uses the actual ${source} failure with background=${background}`, () => {
      ready();
      const f = sessionRejectionFixture(
        status,
        source === "shared",
        background,
      );
      f.sourceClient.warnings = ["raw source warning"];
      const before = JSON.stringify([...f.collection.traces.values()]);
      const r = inspect(f);
      assert.equal(r.trace_id, f.trace.traceID);
      assert.equal(r.status, status);
      assert.equal(r.no_execution, true);
      assert.equal(r.resolution.source, source);
      assert.equal(r.resolution.database_spans, status === 401 ? 1 : 0);
      assert.equal(r.strict_trace, "failed");
      assert.equal(r.warning_count, 1);
      assert.equal(JSON.stringify([...f.collection.traces.values()]), before);
    });

function deadlineRejection(shared = false) {
  const f = sessionRejectionFixture(503, shared);
  for (const span of new Set([f.root, f.sourceRoot, f.sourceClient]))
    failureDiagnostic(
      span,
      "deadline_exceeded",
      "Request deadline exceeded",
      ["context.deadlineExceededError"],
      span === f.sourceClient ? "send" : "request",
    );
  if (shared)
    setTag(
      f.decision,
      "antnest.identity.resolve.cancel_kind",
      "shared-deadline",
    );
  return f;
}
for (const shared of [false, true])
  test(`standalone 503 binds an unwrapped deadline to its completed ${shared ? "shared" : "rpc"} CLIENT`, () => {
    const f = deadlineRejection(shared);
    const before = structuredClone(f.collection.traces);
    const result = inspect(f);
    assert.equal(result.status, 503);
    assert.equal(result.no_execution, true);
    assert.equal(result.resolution.rpc_client_span_id, f.sourceClient.spanID);
    assert.equal(result.resolution.source_trace_id, f.source.traceID);
    assert.equal(
      result.resolution.cancel_kind,
      shared ? "shared-deadline" : undefined,
    );
    assert.deepEqual(result.resolution.transport_failure, {
      type: "deadline_exceeded",
      causes: ["context.deadlineExceededError"],
    });
    assert.equal(result.strict_trace, "failed");
    assert.deepEqual(f.collection.traces, before);
  });
for (const [name, change] of [
  [
    "caller deadline",
    (f) =>
      setTag(
        f.decision,
        "antnest.identity.resolve.cancel_kind",
        "caller-deadline",
      ),
  ],
  [
    "caller cancellation",
    (f) =>
      setTag(
        f.decision,
        "antnest.identity.resolve.cancel_kind",
        "caller-cancelled",
      ),
  ],
  [
    "shared cancellation",
    (f) =>
      setTag(
        f.decision,
        "antnest.identity.resolve.cancel_kind",
        "shared-cancelled",
      ),
  ],
  [
    "process shutdown",
    (f) =>
      setTag(
        f.decision,
        "antnest.identity.resolve.cancel_kind",
        "process-shutdown",
      ),
  ],
  [
    "missing exact source Link",
    (f) => {
      f.decision.references = f.decision.references.filter(
        (r) => r.refType !== "FOLLOWS_FROM",
      );
    },
  ],
  ["foreign source process", (f) => foreignGateway(f.source, f.sourceClient)],
  [
    "unfinished source at decision",
    (f) => {
      f.sourceClient.duration =
        f.decision.startTime +
        f.decision.duration +
        1 -
        f.sourceClient.startTime;
    },
  ],
  [
    "network failure instead of source deadline",
    (f) =>
      failureDiagnostic(
        f.sourceClient,
        "network_error",
        "Network operation failed",
        ["*net.OpError", "*os.SyscallError", "syscall.Errno"],
        "send",
      ),
  ],
  [
    "other source timeout cause",
    (f) =>
      failureDiagnostic(
        f.sourceClient,
        "deadline_exceeded",
        "Request deadline exceeded",
        ["*net.OpError", "*net.timeoutError"],
        "send",
      ),
  ],
  [
    "a cancelled source",
    (f) =>
      failureDiagnostic(
        f.sourceClient,
        "cancelled",
        "Request was cancelled",
        ["*errors.errorString"],
        "send",
      ),
  ],
  [
    "fabricated source response",
    (f) => setTag(f.sourceClient, "http.response.status_code", 503),
  ],
  [
    "source budget above request",
    (f) => setTag(f.sourceClient, "antnest.request.timeout_ms", 2001),
  ],
])
  test("unwrapped shared deadline rejects " + name, () => {
    const f = deadlineRejection(true);
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  [
    "retired session profile",
    (f) => setTag(f.decision, "antnest.identity.resolve.profile", "session"),
  ],
  ["wrong actual path", (f) => (f.expected.path = "/api/session")],
  ["wrong raw route", (f) => setTag(f.root, "http.route", "/api/session")],
  [
    "missing source archive",
    (f) => f.collection.archivedTraceIDs.delete(f.source.traceID),
  ],
  [
    "missing actual CLIENT",
    (f) =>
      (f.source.spans = f.source.spans.filter((s) => s !== f.sourceClient)),
  ],
  [
    "pre-CLIENT cancellation",
    (f) => {
      setTag(
        f.decision,
        "antnest.identity.resolve.shared_source_state",
        "cancelled-before-client",
      );
      setTag(
        f.decision,
        "antnest.identity.resolve.cancel_kind",
        "caller-cancelled",
      );
      f.decision.references = f.decision.references.filter(
        (r) => r.refType !== "FOLLOWS_FROM",
      );
    },
  ],
  [
    "wrong shared source service process",
    (f) =>
      (f.source.processes.edge.tags.find((t) => t.key === "host.name").value =
        "foreign"),
  ],
  [
    "failed SQL",
    (f) =>
      setTag(
        f.source.spans.find((s) => s.spanID === "sql"),
        "otel.status_code",
        2,
      ),
  ],
  [
    "live token row",
    (f) =>
      setTag(
        f.source.spans.find((s) => s.spanID === "sql"),
        "pgx.rows_affected",
        1,
      ),
  ],
  [
    "another SQL statement",
    (f) =>
      setTag(
        f.source.spans.find((s) => s.spanID === "sql"),
        "db.query.text",
        "DELETE FROM api_tokens",
      ),
  ],
  [
    "hidden conflicting SQL",
    (f) =>
      f.source.spans
        .find((s) => s.spanID === "sql")
        .tags.push({ key: "db.query.text", value: "DELETE FROM api_tokens" }),
  ],
  [
    "extra forwarding",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.sourceClient),
        traceID: f.trace.traceID,
        spanID: "extra-forward",
        references: [
          {
            refType: "CHILD_OF",
            traceID: f.trace.traceID,
            spanID: f.root.spanID,
          },
        ],
      }),
  ],
  [
    "unknown refusal error",
    (f) => setTag(f.root, "antnest.error.code", "database_failed"),
  ],
  [
    "extra exception",
    (f) =>
      f.root.logs.push({
        timestamp: f.root.startTime,
        fields: [{ key: "event", value: "exception" }],
      }),
  ],
  [
    "private captured data",
    (f) => setTag(f.root, "unclassified", "PRIVATE-SESSION-REJECTION-CANARY"),
  ],
])
  test(`standalone Bridge rejection refuses ${name}`, () => {
    ready();
    const f = sessionRejectionFixture(401, true);
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  [
    "a cancelled source",
    (f) =>
      failureDiagnostic(
        f.sourceClient,
        "cancelled",
        "Request was cancelled",
        ["*errors.errorString"],
        "send",
      ),
  ],
  [
    "a fabricated upstream response",
    (f) => setTag(f.sourceClient, "http.response.status_code", 200),
  ],
  ["no transport error", (f) => setTag(f.sourceClient, "error", undefined)],
  [
    "unrelated cause chain",
    (f) =>
      (f.sourceClient.logs[0].fields.find(
        (t) => t.key === "antnest.error.cause_types",
      ).value = '["*domain.Error"]'),
  ],
  [
    "unbounded request timeout",
    (f) => setTag(f.sourceClient, "antnest.request.timeout_ms", 2001),
  ],
])
  test(`standalone Bridge outage rejects ${name}`, () => {
    ready();
    const f = sessionRejectionFixture(503, true);
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, background, change] of [
  ["current decision", false, (f) => foreignGateway(f.trace, f.decision)],
  ["shared request root", false, (f) => foreignGateway(f.source, f.sourceRoot)],
  [
    "shared source decision",
    false,
    (f) => foreignGateway(f.source, f.sourceDecision),
  ],
  [
    "background refresh root",
    true,
    (f) => foreignGateway(f.source, f.sourceRoot),
  ],
  [
    "background trigger decision",
    true,
    (f) => {
      const trigger = triggerOf(f);
      foreignGateway(trigger.trace, trigger.decision);
    },
  ],
  [
    "background trigger request root",
    true,
    (f) => {
      const trigger = triggerOf(f);
      foreignGateway(trigger.trace, trigger.root);
    },
  ],
])
  test(`standalone rejection refuses a foreign Gateway process on ${name}`, () => {
    const f = sessionRejectionFixture(401, true, background);
    change(f);
    assert.throws(() => inspect(f), /Gateway process/u);
  });

for (const background of [false, true])
  test(`standalone 503 refuses a contradictory rejected source with background=${background}`, () => {
    const f = sessionRejectionFixture(503, true, background);
    const origin = background ? f.sourceRoot : f.sourceDecision;
    setTag(origin, "antnest.identity.resolve.outcome", "rejected");
    setTag(origin, "otel.status_description", "rejected");
    assert.throws(() => inspect(f), /source outcome/u);
  });

test("standalone 401 retains a cancelled original caller's actual rejected RPC", () => {
  const f = sessionRejectionFixture(401, true);
  setTag(f.sourceDecision, "antnest.identity.resolve.outcome", "unavailable");
  setTag(f.sourceDecision, "otel.status_description", "unavailable");
  inspect(f);
});

function addWork(trace, parent, spanID) {
  trace.spans.push({
    traceID: trace.traceID,
    spanID,
    processID: parent.processID,
    operationName: "unexpected work",
    startTime: parent.startTime,
    duration: 0,
    tags: [{ key: "span.kind", value: "internal" }],
    logs: [],
    references: [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent.spanID },
    ],
  });
}
for (const background of [false, true])
  for (const parentID of ["resolve-server", "sql"])
    test(`standalone 401 refuses extra synchronous source work under ${parentID} with background=${background}`, () => {
      const f = sessionRejectionFixture(401, true, background);
      const parent = f.source.spans.find((s) => s.spanID === parentID);
      assert(parent);
      addWork(f.source, parent, "extra-source-work");
      assert.throws(() => inspect(f), /synchronous/u);
    });

test("standalone rejection does not prohibit unrelated historical source work", () => {
  const f = sessionRejectionFixture(401, true);
  addWork(f.source, f.sourceRoot, "other-source-history");
  inspect(f);
});
