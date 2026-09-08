import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectSessionTrace,
  assertCompletedRun,
} from "./acp-session-evidence.mjs";

function traceFixture() {
  const traceID = "a".repeat(32);
  return {
    traceID,
    processes: { edge: { serviceName: "edge-gateway" } },
    spans: [
      {
        spanID: "root",
        processID: "edge",
        operationName: "HTTP GET",
        tags: [{ key: "http.response.status_code", value: 101 }],
        references: [],
      },
      ...[1, 2, 3, 4].map((n) => ({
        spanID: String(n),
        processID: "edge",
        operationName: "identity.resolve",
        tags: n === 4 ? [{ key: "error", value: true }] : [],
        references: [{ refType: "CHILD_OF", traceID, spanID: "root" }],
      })),
    ],
  };
}
test("session traces require complete message-check evidence, not just handshake presence", () => {
  const trace = traceFixture();
  assert.equal(inspectSessionTrace(trace, trace.traceID, []).session_checks, 4);
  for (const mutate of [
    (t) => t.spans.pop(),
    (t) => (t.spans[4].tags = []),
    (t) => (t.spans[4].references = []),
    (t) => (t.spans[4].references[0].traceID = "b".repeat(32)),
    (t) => (t.spans[0].tags = []),
    (t) => (t.spans[4].processID = "unknown"),
  ]) {
    const invalid = traceFixture();
    mutate(invalid);
    assert.throws(() => inspectSessionTrace(invalid, trace.traceID, []));
  }
  assert.throws(() => inspectSessionTrace(trace, "b".repeat(32), []));
  assert.throws(() =>
    inspectSessionTrace(trace, trace.traceID, ["identity.resolve"]),
  );
});

test("completed Run requires same admission, released authority, no cancellation and one settled Tool", () => {
  const running = { id: "run", admission_id: "admission" };
  const run = {
    ...running,
    state: "completed",
    terminal_class: "completed",
    stop_reason: "end_turn",
    error_class: null,
    cancel_requested_at: null,
    admission_finished_at: "date",
  };
  const tools = [{ state: "completed" }];
  assertCompletedRun(run, running, tools);
  for (const fields of [
    { id: "other" },
    { admission_id: "other" },
    { state: "failed" },
    { terminal_class: "cancelled" },
    { stop_reason: "refusal" },
    { error_class: "lost" },
    { admission_finished_at: null },
    { cancel_requested_at: "date" },
  ])
    assert.throws(() =>
      assertCompletedRun({ ...run, ...fields }, running, tools),
    );
  for (const invalid of [[], [...tools, ...tools], [{ state: "unresolved" }]])
    assert.throws(() => assertCompletedRun(run, running, invalid));
});
