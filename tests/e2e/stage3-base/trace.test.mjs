import assert from "node:assert/strict";
import test from "node:test";
import { inspectLifecycle } from "./trace.mjs";
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
