import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertInterrupted,
  assertReplacement,
  assertBarrierRejection,
} from "./evidence.mjs";
function fixture(kind) {
  const before = {
    run: {
      run_id: "r",
      session_id: "s",
      agent_id: "a",
      principal_id: "p",
      created_at: "t",
      state: kind === "completed" ? "completed" : "running",
      execution_snapshot: { runtime: { revision: "source" } },
      input: [],
      usage_measurements: [],
    },
    events: {
      stream: "execution",
      next_cursor: null,
      items:
        kind === "model-held"
          ? []
          : [
              {
                id: "tool",
                sequence: 1,
                kind: "tool_call",
                visible: true,
                payload: {
                  kind: "tool_call",
                  toolCallId: "t",
                  status: kind === "inflight" ? "in_progress" : "completed",
                },
              },
            ],
    },
  };
  const after = structuredClone(before);
  if (kind !== "completed") {
    Object.assign(after.run, {
      state: kind === "inflight" ? "unresolved" : "failed",
      terminal_class: kind === "inflight" ? "unresolved" : "failed",
      executor_state: "quiescent",
      tool_effect_state:
        kind === "inflight"
          ? "unknown"
          : kind === "model-held"
            ? "none"
            : "settled",
      ...(kind === "inflight" ? { unknown_effect_source: "runtime_mcp" } : {}),
      error_class:
        kind === "inflight"
          ? "service_restarted_during_tool"
          : "service_restarted_during_run",
      stop_reason: null,
    });
    if (kind === "inflight")
      after.events.items.push({
        id: "unknown",
        sequence: 2,
        kind: "tool_call",
        visible: true,
        payload: {
          kind: "tool_call",
          initial: false,
          toolCallId: "t",
          status: "failed",
          content: [
            {
              type: "text",
              text: "Tool outcome is unknown because Agent ACP Service restarted.",
            },
          ],
        },
      });
  }
  return { before, after };
}
test("current public audits distinguish completed, known interrupted and unknown Runtime effects", () => {
  for (const kind of ["completed", "model-held", "tool-held", "inflight"]) {
    const { before, after } = fixture(kind);
    assertInterrupted(before, after, kind);
    const wrong = structuredClone(after);
    wrong.run.state = "completed-invented";
    assert.throws(() => assertInterrupted(before, wrong, kind));
    if (kind === "inflight") {
      for (const modify of [
        (x) => (x.run.tool_effect_state = "settled"),
        (x) => x.events.items.pop(),
        (x) => (x.events.items[0].payload.status = "completed"),
        (x) => (x.events.items[1].payload.status = "completed"),
      ]) {
        const wrong = structuredClone(after);
        modify(wrong);
        assert.throws(() => assertInterrupted(before, wrong, kind));
      }
    }
  }
});
test("replacement keeps template and Agent identity but replaces every execution identity", () => {
  const before = {
      agent_id: "a",
      template_id: "t",
      template_revision: 4,
      runtime_revision: "r",
      runtime_execution_id: "p",
      execution_revision: "e",
    },
    after = {
      ...before,
      runtime_revision: "r2",
      runtime_execution_id: "p2",
      execution_revision: "e2",
    };
  assertReplacement(before, after);
  for (const key of [
    "runtime_revision",
    "runtime_execution_id",
    "execution_revision",
  ])
    assert.throws(() =>
      assertReplacement(before, { ...after, [key]: before[key] }),
    );
});
test("unknown barrier uses the current non-retryable domain error, not legacy busy admission", () => {
  assertBarrierRejection({
    code: -32020,
    data: { code: "runtime_barrier_required", retryable: false },
  });
  assert.throws(() =>
    assertBarrierRejection({
      code: -32021,
      data: { code: "agent_busy", retryable: true },
    }),
  );
});
