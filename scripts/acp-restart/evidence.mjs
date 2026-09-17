import assert from "node:assert/strict";
export function assertInterrupted(before, after, kind) {
  if (kind === "completed") {
    assert.equal(before.run.state, "completed");
    assert.deepEqual(after, before, "restart rewrote completed history");
    return;
  }
  assert.equal(before.run.state, "running");
  const unknown = kind === "inflight";
  assert(["model-held", "tool-held", "inflight"].includes(kind));
  for (const key of [
    "run_id",
    "session_id",
    "agent_id",
    "principal_id",
    "created_at",
    "input",
    "execution_snapshot",
    "usage_measurements",
  ])
    assert.deepEqual(after.run[key], before.run[key], `Run ${key} changed`);
  for (const [key, value] of Object.entries({
    state: unknown ? "unresolved" : "failed",
    terminal_class: unknown ? "unresolved" : "failed",
    executor_state: "quiescent",
    tool_effect_state: unknown
      ? "unknown"
      : kind === "model-held"
        ? "none"
        : "settled",
    error_class: unknown
      ? "service_restarted_during_tool"
      : "service_restarted_during_run",
    stop_reason: null,
  }))
    assert.equal(after.run[key], value, `wrong recovery ${key}`);
  assert.equal(
    after.run.unknown_effect_source ?? null,
    unknown ? "runtime_mcp" : null,
    "wrong recovery unknown_effect_source",
  );
  assert.deepEqual(
    after.events.items.slice(0, before.events.items.length),
    before.events.items,
    "prior execution events changed",
  );
  const tools = before.events.items.filter((e) => e.kind === "tool_call");
  if (!unknown) {
    assert.deepEqual(after.events, before.events);
    if (kind === "model-held") assert.equal(tools.length, 0);
    else
      assert.equal(
        tools.filter((e) => e.payload.status === "completed").length,
        1,
      );
    return;
  }
  const active = tools.filter((e) => e.payload.status === "in_progress");
  assert.equal(active.length, 1, "missing active Tool");
  assert(
    !tools.some((e) =>
      ["completed", "failed", "cancelled"].includes(e.payload.status),
    ),
  );
  const added = after.events.items.slice(before.events.items.length);
  assert.equal(added.length, 1, "missing or duplicated unknown terminal event");
  const last = added[0];
  assert.equal(last.kind, "tool_call");
  assert.equal(last.visible, true);
  assert.equal(last.payload.initial, false);
  assert.equal(last.payload.toolCallId, active[0].payload.toolCallId);
  assert.equal(last.payload.status, "failed");
  assert.deepEqual(last.payload.content, [
    {
      type: "text",
      text: "Tool outcome is unknown because Agent ACP Service restarted.",
    },
  ]);
  assert(last.sequence > before.events.items.at(-1).sequence);
}
export function assertReplacement(before, after) {
  for (const key of ["agent_id", "template_id", "template_revision"])
    assert.equal(after[key], before[key]);
  for (const key of [
    "runtime_revision",
    "runtime_execution_id",
    "execution_revision",
  ]) {
    assert(after[key]);
    assert.notEqual(after[key], before[key]);
  }
}
export function assertBarrierRejection(error) {
  assert.equal(error.code, -32020);
  assert.equal(error.data?.code, "runtime_barrier_required");
  assert.equal(error.data?.retryable, false);
  return true;
}
