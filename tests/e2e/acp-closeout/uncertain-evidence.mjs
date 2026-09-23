import assert from "node:assert/strict";

export function assertUnknownOutcome(before, after) {
  assert.equal(before.run.state, "running");
  assert.equal(before.attempts.length, 1);
  assert.equal(after.attempts.length, 1);
  const original = before.attempts[0];
  assert.equal(original.state, "in_progress");
  assert.equal(original.source, "runtime");
  assert.equal(original.tool_name, "bash");
  for (const key of ["id", "session_id", "admission_id", "execution_snapshot"])
    assert.deepEqual(after.run[key], before.run[key], `Run ${key} changed`);
  assert(before.run.id && before.run.admission_id);
  for (const [key, value] of Object.entries({
    state: "unresolved",
    terminal_class: "unresolved",
    executor_state: "quiescent",
    tool_effect_state: "unknown",
    unknown_effect_source: "runtime_mcp",
    error_class: "service_restarted_during_tool",
    stop_reason: null,
  }))
    assert.equal(after.run[key], value, `unexpected recovery ${key}`);
  assert(after.run.admission_finished_at, "terminal report not acknowledged");
  const attempt = after.attempts[0];
  for (const key of [
    "id",
    "run_id",
    "tool_call_id",
    "source",
    "source_id",
    "tool_name",
    "request_digest",
    "started_at",
    "created_at",
  ])
    assert.deepEqual(attempt[key], original[key], `Tool ${key} changed`);
  assert.equal(attempt.state, "failed");
  assert.equal(attempt.tool_effect_state, "unknown");
  assert(attempt.finished_at);
  const content = [
    {
      type: "text",
      text: "Tool outcome is unknown because Agent ACP Service restarted.",
    },
  ];
  assert.deepEqual(attempt.result_summary, content);
  for (const item of before.messages)
    assert.deepEqual(
      after.messages.find((message) => message.id === item.id),
      item,
      "history rewritten",
    );
  const terminal = after.messages.filter(
    (item) =>
      item.kind === "tool_call" &&
      item.payload.toolCallId === attempt.tool_call_id &&
      item.payload.initial === false &&
      ["failed", "completed", "cancelled"].includes(item.payload.status),
  );
  assert.equal(terminal.length, 1, "expected one terminal Tool update");
  assert.equal(
    terminal[0].visible,
    true,
    "unknown Tool result hidden from conversation",
  );
  assert.equal(terminal[0].payload.status, "failed");
  assert.deepEqual(terminal[0].payload.content, content);
}

export function assertUnknownReplay(replay, callID) {
  const terminal = replay.filter(
    ({ update }) =>
      update.toolCallId === callID &&
      ["failed", "completed", "cancelled"].includes(update.status),
  );
  assert.equal(
    terminal.length,
    1,
    "unknown Tool result missing or duplicated on wire",
  );
  assert.equal(terminal[0].update.sessionUpdate, "tool_call_update");
  assert.equal(terminal[0].update.status, "failed");
  assert.deepEqual(terminal[0].update.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: "Tool outcome is unknown because Agent ACP Service restarted.",
      },
    },
  ]);
}

export function assertReleaseEvents(events, expected) {
  const related = events.filter(
    (event) => event.admission_id === expected.admission,
  );
  assert(related.every((event) => event.agent_id === expected.agent));
  const unknown = related.filter(
    (event) => event.event_type === "run_admission_unresolved",
  );
  assert.equal(unknown.length, 1);
  for (const [key, value] of Object.entries({
    terminal_class: "unresolved",
    tool_effect_state: "unknown",
    unknown_effect_source: "runtime_mcp",
    error_class: "service_restarted_during_tool",
  }))
    assert.equal(unknown[0].data[key], value);
  const released = related.filter(
    (event) => event.event_type === "run_admission_released",
  );
  assert.equal(
    released.length,
    expected.request ? 1 : 0,
    "unexpected occupancy release",
  );
  if (expected.request) {
    const release = released[0];
    assert.equal(release.operation_request_id, expected.request);
    assert(release.aggregate_sequence > unknown[0].aggregate_sequence);
    assert.equal(release.data.release_reason, "runtime_replaced");
    assert.equal(release.data.source_runtime_revision, expected.revision);
  }
  return unknown[0];
}
