import assert from "node:assert/strict";
import test from "node:test";
import {
  clockWarningsOnly,
  inspectLifecycle,
  reviewedFencedRestartOnly,
} from "./trace.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { fixture } from "./trace-fixtures.mjs";

test("an explicitly expected unknown-effect Rebuild requires the current Runtime barrier acknowledgement", () => {
  const f = fixture("rebuild");
  f.expected.settlementOutcome = "runtime_barrier_required";
  assert.throws(() => inspectLifecycle(f.trace, f.expected));
  for (const id of ["settle-agent", "settle-agent-client"])
    f.trace.spans
      .find((s) => s.spanID === id)
      .tags.find((t) => t.key === "antnest.settlement.outcome").value =
      "runtime_barrier_required";
  assert.equal(inspectLifecycle(f.trace, f.expected).settlement, true);
  assert.throws(() =>
    inspectLifecycle(f.trace, {
      ...f.expected,
      settlementOutcome: "not_settled",
    }),
  );
  assert.throws(() =>
    inspectLifecycle(f.trace, { ...f.expected, kind: "disable" }),
  );
  delete f.expected.settlementOutcome;
  assert.throws(() => inspectLifecycle(f.trace, f.expected));
});
test("lost Docker Start response is accepted only after allocation and reconciliation", () => {
  const { trace, expected } = fixture("rebuild");
  const add = (id, name, parent, start, duration, tags) =>
    trace.spans.push({
      traceID: trace.traceID,
      spanID: id,
      processID: "runtime-controller",
      operationName: name,
      startTime: start,
      duration,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent },
      ],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  add(
    "start-loss-lifecycle",
    "runtime.lifecycle.update_runtime",
    "rpc-lifecycle.runtime_update",
    42.05,
    0.9,
    { "antnest.outcome": "completed" },
  );
  add(
    "start-loss-platform",
    "runtime.platform.create",
    "start-loss-lifecycle",
    42.1,
    0.8,
    {
      "antnest.outcome": "completed",
      "antnest.agent.id": "agent-test",
      "antnest.platform": "docker",
      "antnest.runtime.generation": 2,
    },
  );
  add(
    "start-loss-absence",
    "HTTP GET docker",
    "start-loss-platform",
    42.15,
    0.02,
    {
      "span.kind": "client",
      "peer.service": "docker",
      "http.request.method": "GET",
      "http.response.status_code": 404,
      "antnest.outcome": "absent",
    },
  );
  add(
    "start-loss-create",
    "HTTP POST docker",
    "start-loss-platform",
    42.2,
    0.1,
    {
      "span.kind": "client",
      "peer.service": "docker",
      "http.request.method": "POST",
      "http.response.status_code": 201,
    },
  );
  add(
    "start-loss-fault",
    "HTTP POST docker",
    "start-loss-platform",
    42.4,
    0.1,
    {
      "span.kind": "client",
      "peer.service": "docker",
      "http.request.method": "POST",
      "antnest.error.code": "transport_failed",
      "antnest.error.stage": "http_send",
      "otel.status_code": "ERROR",
      error: true,
    },
  );
  add(
    "start-loss-reconcile",
    "HTTP GET docker",
    "start-loss-platform",
    42.6,
    0.1,
    {
      "span.kind": "client",
      "peer.service": "docker",
      "http.request.method": "GET",
      "http.response.status_code": 200,
    },
  );
  assert.throws(() => inspectLifecycle(trace, expected));
  const result = inspectLifecycle(trace, {
    ...expected,
    startResponseLoss: true,
  });
  assert.equal(result.expected_transport_faults, 1);
  assert.equal(result.platform_probe_errors, 0);
  trace.spans
    .find((span) => span.spanID === "start-loss-platform")
    .tags.find((field) => field.key === "antnest.outcome").value = "unknown";
  assert.throws(() =>
    inspectLifecycle(trace, { ...expected, startResponseLoss: true }),
  );
});
for (const kind of ["create", "disable", "enable", "rebuild", "delete"])
  test(`${kind}: current Temporal, SQL and transport boundaries`, () => {
    const { trace, expected } = fixture(kind);
    const result = inspectLifecycle(trace, expected);
    assert.equal(result.kind, kind);
    assert.equal(result.strict_trace, "passed");
    assert.equal(
      result.settlement,
      ["disable", "rebuild", "delete"].includes(kind),
    );
  });
test("Skill preparation queue retry is expected only when declared and followed by successful admission", () => {
  const { trace, expected } = fixture("create");
  const success = trace.spans.find(
    (span) => span.operationName === "RunActivity:admit_agent",
  );
  const retry = structuredClone(success);
  retry.spanID = "skill-queued-retry";
  retry.startTime = success.startTime - 4;
  retry.duration = 1;
  retry.tags.push(
    { key: "span.kind", value: "server" },
    { key: "otel.status_code", value: "ERROR" },
    { key: "error", value: true },
    {
      key: "otel.status_description",
      value: "dependency unavailable: Skill preparation queued",
    },
  );
  trace.spans.push(retry);
  const preparing = structuredClone(retry);
  preparing.spanID = "skill-preparing-retry";
  preparing.startTime = success.startTime - 2;
  preparing.tags.find((tag) => tag.key === "otel.status_description").value =
    "dependency unavailable: Skill preparation preparing";
  trace.spans.push(preparing);
  assert.throws(() => inspectLifecycle(trace, expected));
  const result = inspectLifecycle(trace, {
    ...expected,
    skillPreparation: true,
  });
  assert.equal(result.strict_trace, "passed");
  assert.equal(result.skill_preparation_retries, 2);
  retry.tags.find((tag) => tag.key === "otel.status_description").value =
    "dependency unavailable: Skill preparation rejected";
  assert.throws(() =>
    inspectLifecycle(trace, { ...expected, skillPreparation: true }),
  );
});
function serializationRetryFixture({ failedCommit = false } = {}) {
  const f = fixture("disable");
  const owner = f.trace.spans.find(
    (s) => s.spanID === "rpc-lifecycle.runtime_disable",
  );
  owner.duration = 20;
  const add = (spanID, parent, operationName, offset, tags) => {
    const span = {
      traceID: f.trace.traceID,
      spanID,
      processID: "runtime-controller",
      operationName,
      startTime: owner.startTime + offset,
      duration: 2,
      references: [
        { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: parent },
      ],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    };
    f.trace.spans.push(span);
    return span;
  };
  const conflict = {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "otel.status_code": "ERROR",
    error: true,
    "otel.status_description":
      "ERROR: could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)",
  };
  add("aborted", owner.spanID, "postgresql transaction", 1, {
    "db.system.name": "postgresql",
    ...(failedCommit
      ? {
          "antnest.transaction.outcome": "failed",
          "otel.status_code": "ERROR",
          error: true,
          "error.type": "transaction_error",
        }
      : { "antnest.transaction.outcome": "rolled_back" }),
  });
  add("aborted-statement", "aborted", failedCommit ? "COMMIT" : "DELETE", 1, {
    ...conflict,
    "db.operation.name": failedCommit ? "COMMIT" : "DELETE",
  });
  const retry = add("retry", owner.spanID, "postgresql transaction", 4, {
    "db.system.name": "postgresql",
    "antnest.transaction.outcome": "committed",
  });
  return { ...f, retry, statement: f.trace.spans.at(-2) };
}
test("a serialization abort is accepted only when a committed transaction retries it", () => {
  for (const failedCommit of [false, true]) {
    const { trace, expected } = serializationRetryFixture({ failedCommit });
    const result = inspectLifecycle(trace, expected);
    assert.equal(result.serialization_retries, 1);
    assert.equal(result.platform_probe_errors, 0);
    assert.equal(result.strict_trace, "passed");
  }
  const late = serializationRetryFixture();
  late.retry.startTime -= 2;
  assert.throws(() => inspectLifecycle(late.trace, late.expected));
  const uncommitted = serializationRetryFixture();
  uncommitted.retry.tags.find(
    (t) => t.key === "antnest.transaction.outcome",
  ).value = "rolled_back";
  assert.throws(() =>
    inspectLifecycle(uncommitted.trace, uncommitted.expected),
  );
  const other = serializationRetryFixture();
  other.statement.tags.find((t) => t.key === "otel.status_description").value =
    "ERROR: deadlock detected (SQLSTATE 40P01)";
  assert.throws(() => inspectLifecycle(other.trace, other.expected));
});
test("clock warning waiver rejects platform errors and unrelated trace warnings", () => {
  const warning = {
    strict_trace: "failed",
    warning_count: 1,
    warnings: [
      "clock skew adjustment disabled; not applying calculated delta of -201.857µs",
    ],
    platform_probe_errors: 0,
  };
  assert.equal(clockWarningsOnly([warning]), true);
  assert.equal(
    clockWarningsOnly([
      {
        ...warning,
        warnings: [
          "clock skew adjustment disabled; not applying calculated delta of 717ns",
        ],
      },
    ]),
    true,
  );
  assert.equal(
    clockWarningsOnly([{ ...warning, platform_probe_errors: 1 }]),
    false,
  );
  assert.equal(
    clockWarningsOnly([{ ...warning, warnings: ["missing parent span"] }]),
    false,
  );
});
test("fenced restart waiver accepts only one proven cancellation and clock warnings", () => {
  const restart = {
    kind: "rebuild",
    fenced_restart_cancellation: true,
    strict_trace: "failed",
    restart_error_spans: 2,
    platform_probe_errors: 0,
    warnings: [
      "clock skew adjustment disabled; not applying calculated delta of -1µs",
    ],
  };
  const ordinary = { strict_trace: "passed" };
  assert.equal(reviewedFencedRestartOnly([restart, ordinary]), true);
  assert.equal(
    reviewedFencedRestartOnly([
      { ...restart, restart_error_spans: 3 },
      ordinary,
    ]),
    false,
  );
  assert.equal(
    reviewedFencedRestartOnly([
      { ...restart, platform_probe_errors: 1 },
      ordinary,
    ]),
    false,
  );
  assert.equal(
    reviewedFencedRestartOnly([
      { ...restart, warnings: ["missing parent span"] },
      ordinary,
    ]),
    false,
  );
  assert.equal(reviewedFencedRestartOnly([restart, restart, ordinary]), false);
  assert.equal(
    reviewedFencedRestartOnly([
      restart,
      { ...ordinary, strict_trace: "failed" },
    ]),
    false,
  );
});
for (const [name, mutate] of [
  [
    "missing real commit",
    (t) =>
      (t.spans
        .find((s) => s.operationName === "postgresql transaction")
        .tags.find((f) => f.key === "antnest.transaction.outcome").value =
        "rolled_back"),
  ],
  [
    "Runtime command mismatch",
    (t) =>
      (t.spans
        .find((s) => tag(s, "antnest.operation.request_id"))
        .tags.find((f) => f.key === "antnest.operation.request_id").value =
        "foreign"),
  ],
  [
    "missing publication",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "apply-execution-snapshot")
        .tags.find((f) => f.key === "http.route").value = "/old-route"),
  ],
  [
    "wrong settlement",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "settle-agent-client")
        .tags.find((f) => f.key === "antnest.settlement.outcome").value =
        "not_settled"),
  ],
  [
    "foreign operation",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "settle-agent-client")
        .tags.find((f) => f.key === "antnest.operation.id").value = "foreign"),
  ],
  [
    "execution leak",
    (t) =>
      (t.spans.find((s) => s.spanID === "sql-lifecycle.drain").operationName =
        "agent.run"),
  ],
  [
    "captured payload",
    (t) =>
      (t.spans[0].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ]),
  ],
  [
    "unexpected service error",
    (t) => t.spans[0].tags.push({ key: "error", value: true }),
  ],
])
  test(`lifecycle rejects ${name}`, () => {
    const { trace, expected } = fixture("rebuild");
    mutate(trace);
    assert.throws(() => inspectLifecycle(trace, expected));
  });
test("clock warnings remain a strict failure after topology checks", () => {
  const { trace, expected } = fixture("create");
  trace.spans[0].warnings = ["clock skew"];
  const result = inspectLifecycle(trace, expected);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.warning_count, 1);
});

function probeFixture() {
  const f = fixture("create"),
    t = f.trace;
  const owner = t.spans.find((s) => s.spanID === "rpc-runtime_initialize");
  const add = (id, parent, operationName, offset, tags) =>
    t.spans.push({
      traceID: t.traceID,
      spanID: id,
      processID: "runtime-controller",
      operationName,
      startTime: owner.startTime + offset,
      duration: 1,
      references: [{ refType: "CHILD_OF", traceID: t.traceID, spanID: parent }],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  add("platform", owner.spanID, "runtime.platform.create", 0, {
    "antnest.agent.id": "agent-test",
    "antnest.outcome": "completed",
    "antnest.platform": "docker",
  });
  add("probe", "platform", "HTTP GET docker", 1, {
    "span.kind": "client",
    "peer.service": "docker",
    "http.request.method": "GET",
    "http.response.status_code": 404,
    "antnest.error.code": "404",
    "error.type": "protocol_error",
    error: true,
  });
  add("allocate", "platform", "HTTP POST docker", 2, {
    "span.kind": "client",
    "peer.service": "docker",
    "http.request.method": "POST",
    "http.response.status_code": 201,
    "antnest.outcome": "completed",
  });
  add("start", "platform", "HTTP POST docker", 3, {
    "span.kind": "client",
    "peer.service": "docker",
    "http.request.method": "POST",
    "http.response.status_code": 204,
    "antnest.outcome": "completed",
  });
  return f;
}
test("proven Docker absence probes do not hide their strict error-span failure", () => {
  const { trace, expected } = probeFixture();
  const result = inspectLifecycle(trace, expected);
  assert.equal(result.platform_probe_errors, 1);
  assert.equal(result.strict_trace, "failed");
});
for (const [name, mutate] of [
  [
    "unreconciled absence",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "allocate")
        .tags.find((f) => f.key === "http.response.status_code").value = 500),
  ],
  [
    "foreign Runtime owner",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "platform")
        .tags.find((f) => f.key === "antnest.agent.id").value = "other"),
  ],
  [
    "failed platform operation",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "platform")
        .tags.find((f) => f.key === "antnest.outcome").value = "failed"),
  ],
  [
    "non-absence HTTP error",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "probe")
        .tags.find((f) => f.key === "http.response.status_code").value = 500),
  ],
])
  test(`Docker diagnostic rejects ${name}`, () => {
    const { trace, expected } = probeFixture();
    mutate(trace);
    assert.throws(() => inspectLifecycle(trace, expected));
  });

function expectedAbsenceFixture() {
  const f = probeFixture();
  const probe = f.trace.spans.find((s) => s.spanID === "probe");
  probe.tags = probe.tags.filter(
    (t) =>
      ![
        "error",
        "error.type",
        "antnest.error.code",
        "otel.status_code",
      ].includes(t.key),
  );
  probe.tags.push({ key: "antnest.outcome", value: "absent" });
  return f;
}
test("settlement ordering uses agent-controller client timestamps", () => {
  const f = fixture("delete");
  const span = (id) => f.trace.spans.find((s) => s.spanID === id);
  const appliedClient = span("apply-execution-snapshot-client");
  const settledClient = span("settle-agent-client");
  const applied = span("apply-execution-snapshot");
  const settled = span("settle-agent");
  // agent-acp-service truncates server start times to milliseconds.
  const start = appliedClient.startTime;
  Object.assign(appliedClient, { startTime: start, duration: 1050 });
  Object.assign(applied, { startTime: start, duration: 1046 });
  Object.assign(settledClient, { startTime: start + 1060, duration: 900 });
  Object.assign(settled, { startTime: start + 1000, duration: 900 });
  assert.equal(inspectLifecycle(f.trace, f.expected).settlement, true);
  settledClient.startTime = start + 1049;
  assert.throws(
    () => inspectLifecycle(f.trace, f.expected),
    /settlement preceded publication/,
  );
});
const cleanupPhase = {
  delete: "runtime_delete",
  disable: "runtime_disable",
  rebuild: "runtime_update",
};
function deleteAbsenceFixture(kind = "delete") {
  const f = fixture(kind),
    t = f.trace;
  const owner = t.spans.find(
    (s) => s.spanID === `rpc-lifecycle.${cleanupPhase[kind]}`,
  );
  const add = (id, parent, operationName, offset, tags) =>
    t.spans.push({
      traceID: t.traceID,
      spanID: id,
      processID: "runtime-controller",
      operationName,
      startTime: owner.startTime + offset,
      duration: 1,
      references: [{ refType: "CHILD_OF", traceID: t.traceID, spanID: parent }],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  add("platform", owner.spanID, "runtime.platform.delete", 0, {
    "antnest.agent.id": "agent-test",
    "antnest.outcome": "completed",
    "antnest.platform": "docker",
  });
  add("remove", "platform", "HTTP DELETE docker", 1, {
    "span.kind": "client",
    "peer.service": "docker",
    "http.request.method": "DELETE",
    "http.response.status_code": 204,
    "antnest.outcome": "completed",
  });
  add("probe", "platform", "HTTP GET docker", 2, {
    "span.kind": "client",
    "peer.service": "docker",
    "http.request.method": "GET",
    "http.response.status_code": 404,
    "antnest.outcome": "absent",
  });
  return f;
}
for (const kind of Object.keys(cleanupPhase))
  test(`${kind} accepts an expected absent Runtime cleanup resource`, () => {
    const f = deleteAbsenceFixture(kind);
    const result = inspectLifecycle(f.trace, f.expected);
    assert.equal(result.platform_probe_errors, 0);
    assert.equal(result.platform_absence_probes, 1);
    assert.equal(result.strict_trace, "passed");
  });
for (const [name, mutate] of [
  [
    "an error-status absence",
    (f) =>
      f.trace.spans
        .find((s) => s.spanID === "probe")
        .tags.push(
          { key: "error", value: true },
          { key: "antnest.error.code", value: "404" },
          { key: "error.type", value: "protocol_error" },
        ),
  ],
  [
    "a foreign Runtime owner",
    (f) =>
      (f.trace.spans
        .find((s) => s.spanID === "platform")
        .tags.find((t) => t.key === "antnest.agent.id").value = "other"),
  ],
  [
    "a failed platform delete",
    (f) =>
      (f.trace.spans
        .find((s) => s.spanID === "platform")
        .tags.find((t) => t.key === "antnest.outcome").value = "failed"),
  ],
  ["another lifecycle kind", (f) => (f.expected.kind = "disable")],
  [
    "a foreign Runtime command",
    (f) =>
      (f.trace.spans
        .find((s) => s.spanID === "client-rpc-lifecycle.runtime_delete")
        .tags.find((t) => t.key === "antnest.operation.request_id").value =
        "acr_foreign"),
  ],
  [
    "an allocation during delete",
    (f) => {
      const probe = f.trace.spans.find((s) => s.spanID === "probe");
      f.trace.spans.push({
        ...probe,
        spanID: "allocate",
        operationName: "HTTP POST docker",
        startTime: probe.startTime + 1,
        tags: [
          { key: "span.kind", value: "client" },
          { key: "peer.service", value: "docker" },
          { key: "http.request.method", value: "POST" },
          { key: "http.response.status_code", value: 201 },
        ],
      });
    },
  ],
])
  test(`Delete absence rejects ${name}`, () => {
    const f = deleteAbsenceFixture();
    mutate(f);
    let result;
    try {
      result = inspectLifecycle(f.trace, f.expected);
    } catch {
      return;
    }
    assert.equal(result.strict_trace, "failed");
  });
test("expected absence preserves 404 and requires actual successful allocation", () => {
  const f = expectedAbsenceFixture();
  const result = inspectLifecycle(f.trace, f.expected);
  assert.equal(result.platform_probe_errors, 0);
  assert.equal(result.platform_absence_probes, 1);
  assert.equal(result.strict_trace, "passed");
  for (const mutate of [
    (x) =>
      (x.trace.spans
        .find((s) => s.spanID === "probe")
        .tags.find((t) => t.key === "antnest.outcome").value = "completed"),
    (x) =>
      (x.trace.spans = x.trace.spans.filter((s) => s.spanID !== "allocate")),
  ]) {
    const x = expectedAbsenceFixture();
    mutate(x);
    assert.throws(() => inspectLifecycle(x.trace, x.expected));
  }
});
