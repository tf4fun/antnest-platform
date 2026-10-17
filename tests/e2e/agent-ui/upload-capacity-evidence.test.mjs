import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityFixture } from "./upload-capacity-fixtures.mjs";
import { inspectCapacityCase } from "./upload-capacity-evidence.mjs";

for (const phase of ["body-incomplete", "body-completion-and-parse"])
  for (const path of ["operation-cancel", "commands-stop"])
    test(
      "accepts actual phase, target and 64-stream evidence: " +
        phase +
        " " +
        path,
      () => {
        const result = inspectCapacityCase(capacityFixture(phase, path));
        assert.equal(result.completion_ms, 40);
        assert.equal(result.sse_streams, 64);
      },
    );

const ui = (r) => r.upload.trace.spans[1];
const event = (r, i) =>
  ui(r).logs[i].fields.find((t) => t.key === "monotonic_ns");
const mutations = [
  ["same user", (r) => (r.scope.user_b = r.scope.user_a)],
  ["same Agent", (r) => (r.scope.agent_b = r.scope.agent_a)],
  ["unknown phase", (r) => (r.phase = "waiting-for-upstream")],
  ["unknown control", (r) => (r.cancel_path = "unscoped-cancel")],
  ["wrong upload path", (r) => (r.upload.path = r.cancel.path)],
  ["wrong upload Trace", (r) => (r.upload.trace.traceID = "f".repeat(32))],
  ["detached UI HTTP", (r) => (ui(r).references = [])],
  [
    "different UI process",
    (r) =>
      (r.calibration.after[0].trace.processes.ui.tags[0].value = "replacement"),
  ],
  ["missing original clock", (r) => ui(r).tags.pop()],
  [
    "clock sample not decimal",
    (r) => (r.calibration.before[0].sent_ns = "1e6"),
  ],
  [
    "inverted complete request",
    (r) => (r.calibration.before[0].complete_ns = "0"),
  ],
  ["non-bracketing calibration", (r) => (r.calibration.after[0].sent_ns = "1")],
  [
    "duplicate calibration Trace",
    (r) => (r.calibration.after[0] = structuredClone(r.calibration.after[1])),
  ],
  [
    "incompatible phase clock samples",
    (r) =>
      (r.calibration.before[0].trace.spans[1].tags.at(-1).value = "8000000"),
  ],
  [
    "only midpoint overlaps",
    (r) => r.calibration.before.forEach((s) => (s.complete_ns = "40000000")),
  ],
  ["clock uncertainty crosses EOF", (r) => (r.cancel.sent_ns = "50000000")],
  ["cancel after parse", (r) => (r.cancel.sent_ns = "110000000")],
  [
    "waiting upstream mistaken for parsing",
    (r) => {
      r.cancel.sent_ns = "200000000";
      r.cancel.complete_ns = "220000000";
      r.terminal.at_ns = "230000000";
      r.runtime.quiescent.at_ns = "240000000";
    },
  ],
  ["missing EOF", (r) => ui(r).logs.splice(1, 1)],
  ["duplicate phase", (r) => ui(r).logs.push(structuredClone(ui(r).logs[1]))],
  ["phase out of order", (r) => (event(r, 2).value = "40000000")],
  [
    "foreign phase byte count",
    (r) => ui(r).logs[2].fields.find((t) => t.key === "bytes").value--,
  ],
  [
    "invented fifth phase attribute",
    (r) => ui(r).logs[0].fields.push({ key: "content", value: "private" }),
  ],
  ["rejected upload", (r) => (r.upload.status = 413)],
  ["undersized load", (r) => (r.upload.wire_bytes = r.upload.limit / 2)],
  ["oversized load", (r) => (r.upload.wire_bytes = r.upload.limit + 1)],
  ["unsupported image", (r) => (r.upload.capabilities.image = false)],
  [
    "oversized individual attachment",
    (r) => (r.upload.attachments[0].size = 5 * 1024 * 1024),
  ],
  [
    "provider missed original image",
    (r) => (r.upload_model.images[1].sha256 = "f".repeat(64)),
  ],
  ["wrong cancel Run", (r) => (r.cancel.request.expectedRunId = "other")],
  ["cancel rejected", (r) => (r.cancel.status = 409)],
  [
    "cancel response delayed",
    (r) =>
      (r.cancel.complete_ns = String(BigInt(r.cancel.sent_ns) + 1000000001n)),
  ],
  ["wrong terminal Run", (r) => (r.terminal.operation.runId = "other")],
  ["wrong terminal Session", (r) => (r.terminal.operation.sessionId = "other")],
  ["only cancelling", (r) => (r.terminal.operation.phase = "cancelling")],
  ["natural completion", (r) => (r.terminal.operation.phase = "completed")],
  [
    "terminal late",
    (r) => (r.terminal.at_ns = String(BigInt(r.cancel.sent_ns) + 1000000001n)),
  ],
  [
    "foreign Runtime organization",
    (r) => (r.runtime.organization_id = "other"),
  ],
  [
    "replacement Runtime",
    (r) => (r.runtime.quiescent.container.id = "c".repeat(64)),
  ],
  [
    "replacement execution",
    (r) => (r.runtime.quiescent.status.execution_id = "other"),
  ],
  ["other process group", (r) => r.runtime.quiescent.work.pgid++],
  [
    "already idle before cancel",
    (r) => (r.runtime.before_cancel.work.processes = ""),
  ],
  [
    "live child after parent exit",
    (r) => (r.runtime.quiescent.work.processes = "41 (sleep) S 1 40 0\n"),
  ],
  [
    "quiescence late",
    (r) =>
      (r.runtime.quiescent.at_ns = String(
        BigInt(r.cancel.sent_ns) + 1000000001n,
      )),
  ],
  ["unrelated audit", (r) => (r.audit.run_id = "other")],
  ["wrong audit principal", (r) => (r.audit.principal_id = "user-a")],
  ["audit natural completion", (r) => (r.audit.terminal_class = "completed")],
  ["model continued after held Tool", (r) => (r.held_model.continuations = 1)],
  ["63 streams", (r) => r.pool.pop()],
  ["duplicate stream", (r) => (r.pool[1] = structuredClone(r.pool[0]))],
  ["five owners beyond intended pool", (r) => (r.pool[0].agent_id = "fifth")],
  ["wrong SSE principal", (r) => (r.pool[0].principal_id = "stranger")],
  ["wrong SSE selection", (r) => (r.pool[0].view.selectedSessionId = "other")],
  ["closed during cancel", (r) => (r.pool[0].closed_ns = r.cancel.sent_ns)],
  [
    "not live through quiescence",
    (r) => (r.pool[0].live_after_ns = r.cancel.sent_ns),
  ],
  ["reader not joined", (r) => (r.pool[0].joined = false)],
  ["65th admitted", (r) => (r.overflow.status = 200)],
  [
    "wrong rejection source",
    (r) => (r.overflow.body.message = "Owner capacity exceeded"),
  ],
];
for (const [name, mutate] of mutations)
  test("rejects " + name, () => {
    const record = capacityFixture();
    mutate(record);
    assert.throws(() => inspectCapacityCase(record));
  });
test("receiving proof rejects cancellation after EOF", () => {
  const r = capacityFixture("body-incomplete");
  r.cancel.sent_ns = "80000000";
  assert.throws(() => inspectCapacityCase(r));
});

const reviewMutations = [
  [
    "forged execution revision",
    (r) => (r.runtime.execution_revision = "other"),
  ],
  ["forged runtime revision", (r) => (r.runtime.runtime_revision = "other")],
  ["foreign persisted Run", (r) => (r.run_snapshot.run_id = "other")],
  [
    "foreign executor process group",
    (r) =>
      (r.work_trace.spans
        .at(-1)
        .tags.find((t) => t.key === "executor.child.pid").value = "99"),
  ],
  [
    "natural Runtime completion",
    (r) =>
      (r.work_trace.spans
        .at(-1)
        .tags.find((t) => t.key === "executor.exit.classification").value =
        "success"),
  ],
  [
    "overflow before pool ready",
    (r) => {
      r.overflow.sent_ns = "1";
      r.overflow.complete_ns = "2";
    },
  ],
  [
    "stream closed before claimed live observation",
    (r) => (r.pool[0].closed_ns = r.pool[0].live_after_ns),
  ],
  ["SSE raw source missing", (r) => delete r.pool[0].raw],
  [
    "SSE original Trace replaced",
    (r) => (r.pool[0].raw.trace_id = "e".repeat(32)),
  ],
  ["SSE remote closure", (r) => (r.pool[0].raw.closure.kind = "remote-end")],
  [
    "SSE original process changed",
    (r) => (r.pool[0].trace.processes.ui.tags[0].value = "replacement"),
  ],
  ["upload completion before send", (r) => (r.upload.complete_ns = "0")],
  [
    "cancel HTTP outside client window",
    (r) => (r.cancel.trace.spans[1].tags.at(-1).value = "1"),
  ],
  [
    "borrowed POST trace header",
    (r) => (r.cancel.response_trace_id = "e".repeat(32)),
  ],
  [
    "uncertain without cancellation proof",
    (r) => (r.terminal.operation.errorClass = "tool_outcome_unknown"),
  ],
];
for (const [name, mutate] of reviewMutations)
  test("review rejects " + name, () => {
    const r = capacityFixture();
    mutate(r);
    assert.throws(() => inspectCapacityCase(r));
  });

for (const [name, mutate] of [
  ["client EOF before send", (r) => (r.upload.eof_sent_ns = "1")],
  ["client EOF after response", (r) => (r.upload.eof_sent_ns = "400000000")],
  ["client EOF after native EOF", (r) => (r.upload.eof_sent_ns = "51000000")],
])
  test("review rejects " + name, () => {
    const r = capacityFixture();
    mutate(r);
    assert.throws(() => inspectCapacityCase(r));
  });
test("receiving must remain unfinished through complete B cancellation", () => {
  const r = capacityFixture("body-incomplete");
  r.upload.eof_sent_ns = "25000000";
  assert.throws(() => inspectCapacityCase(r));
});

for (const [name, mutate] of [
  ["missing upload model Trace", (r) => delete r.upload_model.trace_id],
  [
    "borrowed upload model span",
    (r) => (r.upload_model.model_span_id = "f".repeat(16)),
  ],
  ["different upload Run", (r) => (r.upload_terminal.runId = "other")],
  [
    "upload audit from other principal",
    (r) => (r.upload_audit.principal_id = r.scope.user_b),
  ],
  [
    "overflow response Trace mismatch",
    (r) => (r.overflow.response_trace_id = "f".repeat(32)),
  ],
  [
    "overflow from other Gateway",
    (r) => (r.overflow.trace.processes.edge.tags[0].value = "replacement"),
  ],
  [
    "overflow proxied to UI",
    (r) =>
      r.overflow.trace.spans.push(structuredClone(r.upload.trace.spans[1])),
  ],
])
  test("review rejects " + name, () => {
    const r = capacityFixture();
    mutate(r);
    assert.throws(() => inspectCapacityCase(r));
  });

function allHttpReceipts(r) {
  return [
    r.upload,
    r.cancel,
    r.overflow,
    ...r.calibration.before,
    ...r.calibration.after,
    ...r.pool,
  ];
}
for (const representation of ["legacy", "matching aliases"]) {
  test(
    "accepts original Jaeger HTTP status representation: " + representation,
    () => {
      const r = capacityFixture();
      for (const receipt of allHttpReceipts(r))
        for (const span of receipt.trace.spans) {
          const current = span.tags.find(
            (t) => t.key === "http.response.status_code",
          );
          if (!current) continue;
          if (representation === "legacy") current.key = "http.status_code";
          else
            span.tags.push({ key: "http.status_code", value: current.value });
        }
      assert.equal(inspectCapacityCase(r).sse_streams, 64);
    },
  );
}
for (const kind of ["UI", "Gateway overflow"]) {
  test("rejects conflicting original HTTP status aliases: " + kind, () => {
    const r = capacityFixture();
    const receipt = kind === "UI" ? r.upload : r.overflow;
    const span = receipt.trace.spans.find((s) =>
      s.tags.some((t) => t.key === "http.response.status_code"),
    );
    span.tags.push({ key: "http.status_code", value: 599 });
    assert.throws(() => inspectCapacityCase(r), /conflicting HTTP status/);
  });
}
test("rejects a ninth subscriber in one real Session selection", () => {
  const r = capacityFixture();
  r.pool[8] = JSON.parse(
    JSON.stringify(r.pool[8]).replaceAll("session-a-aux", "session-a"),
  );
  assert.throws(() => inspectCapacityCase(r), /Session subscriber capacity/);
});
test("requires distinct primary and auxiliary Session selections", () => {
  const r = capacityFixture();
  r.scope.session_a_aux = r.scope.session_a;
  assert.throws(() => inspectCapacityCase(r), /distinct Session/);
});

test("rejects a third Session selection in one filler owner", () => {
  const r = capacityFixture();
  r.pool[40] = JSON.parse(
    JSON.stringify(r.pool[40]).replaceAll(
      "filler-session-a-aux",
      "third-session",
    ),
  );
  assert.throws(() => inspectCapacityCase(r), /two Session selections/);
});
test("rejects an undeclared auxiliary Session for a primary Agent", () => {
  const r = capacityFixture();
  for (let i = 8; i < 16; i++)
    r.pool[i] = JSON.parse(
      JSON.stringify(r.pool[i]).replaceAll(
        "session-a-aux",
        "undeclared-session",
      ),
    );
  assert.throws(() => inspectCapacityCase(r), /undeclared primary Session/);
});

test("accepts a cancellation-specific terminal response that races the cancel reply", () => {
  const r = capacityFixture();
  r.cancel.response = structuredClone(r.terminal.operation);
  assert.equal(inspectCapacityCase(r).completion_ms, 40);
});
test("rejects an uncertain cancel reply without cancellation-specific outcome", () => {
  const r = capacityFixture();
  r.cancel.response = { ...r.terminal.operation, errorClass: "other_unknown" };
  assert.throws(() => inspectCapacityCase(r), /terminal cancellation response/);
});

test("selects original held Bash among real Runtime info executors", () => {
  const r = capacityFixture();
  const bash = r.work_trace.spans.find(
    (s) => s.operationName === "runtime.executor",
  );
  for (const [id, pid] of [
    ["1", "39"],
    ["2", "80"],
  ]) {
    const info = structuredClone(bash);
    info.spanID = id.repeat(16);
    info.tags.find((t) => t.key === "executor.tool.name").value = "info";
    info.tags.find((t) => t.key === "executor.child.pid").value = pid;
    info.tags.find((t) => t.key === "executor.exit.classification").value =
      "success";
    r.work_trace.spans.push(info);
  }
  assert.equal(inspectCapacityCase(r).completion_ms, 40);
});
test("rejects two Bash executors claiming the same original process group", () => {
  const r = capacityFixture();
  const duplicate = structuredClone(
    r.work_trace.spans.find((s) => s.operationName === "runtime.executor"),
  );
  duplicate.spanID = "1".repeat(16);
  r.work_trace.spans.push(duplicate);
  assert.throws(() => inspectCapacityCase(r), /missing or duplicate/);
});
