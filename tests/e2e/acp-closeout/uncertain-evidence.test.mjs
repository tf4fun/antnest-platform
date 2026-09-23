import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertUnknownOutcome,
  assertReleaseEvents,
  assertUnknownReplay,
} from "./uncertain-evidence.mjs";

const before = {
  run: {
    id: "run-1",
    session_id: "session-1",
    admission_id: "admission-1",
    execution_snapshot: { runtime: { revision: "runtime-1" } },
    state: "running",
  },
  attempts: [
    {
      id: "attempt-1",
      run_id: "run-1",
      tool_call_id: "call-1",
      source: "runtime",
      source_id: "runtime-1",
      tool_name: "bash",
      request_digest: "digest",
      state: "in_progress",
      started_at: "start",
      created_at: "start",
    },
  ],
  messages: [
    {
      id: "initial",
      kind: "tool_call",
      payload: {
        initial: true,
        toolCallId: "call-1",
        status: "in_progress",
        arguments: { command: "append" },
      },
    },
  ],
};
const content = [
  {
    type: "text",
    text: "Tool outcome is unknown because Agent ACP Service restarted.",
  },
];
function recovered() {
  return {
    run: {
      ...structuredClone(before.run),
      state: "unresolved",
      terminal_class: "unresolved",
      executor_state: "quiescent",
      tool_effect_state: "unknown",
      unknown_effect_source: "runtime_mcp",
      error_class: "service_restarted_during_tool",
      stop_reason: null,
      admission_finished_at: "finish",
    },
    attempts: [
      {
        ...before.attempts[0],
        state: "failed",
        tool_effect_state: "unknown",
        result_summary: content,
        finished_at: "finish",
      },
    ],
    messages: [
      ...structuredClone(before.messages),
      {
        id: "terminal",
        kind: "tool_call",
        visible: true,
        payload: {
          initial: false,
          toolCallId: "call-1",
          status: "failed",
          content,
        },
      },
    ],
  };
}
test("unknown recovery preserves intent and reports uncertainty instead of success", () => {
  assertUnknownOutcome(before, recovered());
  for (const mutate of [
    (x) => (x.run.state = "failed"),
    (x) => (x.run.stop_reason = "end_turn"),
    (x) => (x.run.admission_id = "other"),
    (x) => (x.run.unknown_effect_source = "client_mcp"),
    (x) => (x.attempts[0].request_digest = "changed"),
    (x) => (x.attempts[0].tool_effect_state = "settled"),
    (x) => (x.messages[0].payload.arguments = {}),
    (x) => (x.messages[1].payload.status = "completed"),
    (x) => (x.messages[1].visible = false),
    (x) => x.messages.push(structuredClone(x.messages[1])),
  ]) {
    const value = recovered();
    mutate(value);
    assert.throws(() => assertUnknownOutcome(before, value));
  }
});
test("unknown outcome is delivered exactly once on the wire, not only stored", () => {
  const update = {
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "failed",
      content: content.map((item) => ({ type: "content", content: item })),
    },
  };
  assertUnknownReplay([update], "call-1");
  for (const invalid of [
    [],
    [update, update],
    [{ update: { ...update.update, status: "completed" } }],
    [{ update: { ...update.update, content: [] } }],
  ])
    assert.throws(() => assertUnknownReplay(invalid, "call-1"));
});
const unknown = {
  event_id: "event-1",
  agent_id: "agent-1",
  admission_id: "admission-1",
  event_type: "run_admission_unresolved",
  aggregate_sequence: 5,
  data: {
    terminal_class: "unresolved",
    tool_effect_state: "unknown",
    unknown_effect_source: "runtime_mcp",
    error_class: "service_restarted_during_tool",
  },
};
const release = {
  event_id: "event-2",
  agent_id: "agent-1",
  admission_id: "admission-1",
  event_type: "run_admission_released",
  aggregate_sequence: 8,
  operation_request_id: "rebuild-1",
  data: {
    release_reason: "runtime_replaced",
    source_runtime_revision: "runtime-1",
  },
};
test("occupancy release belongs to the same admission and explicit replacement", () => {
  const expected = {
    agent: "agent-1",
    admission: "admission-1",
    request: "rebuild-1",
    revision: "runtime-1",
  };
  assertReleaseEvents([unknown], { ...expected, request: undefined });
  assertReleaseEvents([unknown, release], expected);
  for (const invalid of [
    { ...release, operation_request_id: "other" },
    { ...release, aggregate_sequence: 4 },
    { ...release, data: { ...release.data, release_reason: "timeout" } },
    { ...release, data: { ...release.data, source_runtime_revision: "other" } },
  ])
    assert.throws(() => assertReleaseEvents([unknown, invalid], expected));
  assert.throws(() =>
    assertReleaseEvents([unknown, release], {
      ...expected,
      request: undefined,
    }),
  );
  assert.throws(() =>
    assertReleaseEvents([unknown, unknown, release], expected),
  );
  assert.throws(() => assertReleaseEvents([], expected));
});
