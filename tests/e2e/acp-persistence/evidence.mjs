import assert from "node:assert/strict";
export function assertDurable(saved, receipt) {
  const { run, events } = saved;
  assert.equal(run.run_id, receipt.run_id);
  assert.equal(run.session_id, receipt.session_id);
  assert.equal(receipt.delivery, "held");
  assert(receipt.receipt_id);
  assert.match(receipt.query_hash, /^[a-f0-9]{64}$/);
  assert.equal(
    receipt.command_tag,
    receipt.phase === "finish" ? "SELECT 1" : "COMMIT",
  );
  assert.equal(
    run.state,
    { intent: "admitting", accept: "running", finish: "completed" }[
      receipt.phase
    ],
  );
  if (receipt.phase === "intent") {
    assert.equal(run.execution_snapshot, null);
    assert.deepEqual(events.items, []);
  } else {
    assert(run.execution_snapshot);
    assert.equal(
      events.items.filter((e) => e.kind === "user_message").length,
      1,
    );
    if (receipt.phase === "accept")
      assert(
        !events.items.some((e) =>
          ["tool_call", "agent_message"].includes(e.kind),
        ),
      );
    else {
      assert.equal(run.terminal_class, "completed");
      assert.equal(run.executor_state, "quiescent");
      assert.equal(run.tool_effect_state, "settled");
      assert.equal(run.stop_reason, "end_turn");
      assert.equal(
        events.items.filter(
          (e) => e.kind === "tool_call" && e.payload.status === "completed",
        ).length,
        1,
      );
      assert.equal(
        events.items.filter((e) => e.kind === "agent_message" && e.visible)
          .length,
        1,
      );
    }
  }
}
export function assertRecovered(before, after, phase) {
  if (phase === "finish")
    return assert.deepEqual(after, before, "terminal history rewritten");
  assert.equal(after.run.run_id, before.run.run_id);
  assert.equal(after.run.state, "failed");
  // An intent rejected before acceptance has no execution outcome. Current
  // ACP stores the admission failure in state/error_class, with null outcomes.
  assert.equal(after.run.terminal_class, phase === "intent" ? null : "failed");
  assert.equal(
    after.run.executor_state,
    phase === "intent" ? null : "quiescent",
  );
  assert.equal(after.run.tool_effect_state, phase === "intent" ? null : "none");
  assert.equal(
    after.run.error_class,
    phase === "intent"
      ? "service_restarted_before_execution"
      : "service_restarted_during_run",
  );
  assert.deepEqual(after.run.execution_snapshot, before.run.execution_snapshot);
  assert.deepEqual(
    after.events,
    before.events,
    "recovery changed execution history",
  );
}
const optional = (x) => x ?? null;
function tool(u) {
  return [
    u.sessionUpdate,
    u.toolCallId,
    u.status,
    optional(u.rawInput),
    optional(u.rawOutput),
    optional(u.content),
    optional(u.locations),
    optional(u.kind),
    optional(u.title),
    optional(u.name),
  ];
}
export function assertReplay(version, updates, saved, sessionId) {
  assert(
    updates.every((u) => u.sessionId === sessionId),
    "foreign replay",
  );
  const expected = saved.events.items
    .filter((e) => e.visible && e.payload.kind !== "state")
    .flatMap(({ payload: e }) => {
      if (["user_message", "agent_message", "agent_thought"].includes(e.kind))
        return (version === 1 ? e.content : [e.content]).map((content) => [
          e.kind + (version === 1 ? "_chunk" : ""),
          version === 1 ? (e.responseId ?? e.messageId) : e.messageId,
          content,
        ]);
      if (e.kind === "tool_call")
        return [
          tool({
            sessionUpdate:
              version === 1 && e.initial ? "tool_call" : "tool_call_update",
            toolCallId: e.toolCallId,
            status:
              version === 1 && e.status === "cancelled" ? "failed" : e.status,
            rawInput: e.arguments,
            rawOutput: e.rawOutput,
            content: e.content?.map((content) => ({
              type: "content",
              content,
            })),
            locations: e.locations,
            kind: e.toolKind,
            title: e.title,
            name: e.modelName,
          }),
        ];
      assert.equal(e.kind, "usage", "unaccounted durable event");
      return [["usage_update", e.used, e.size, optional(e.cost)]];
    });
  const metadata = [
    "available_commands_update",
    "session_info_update",
    "config_option_update",
  ];
  const actual = updates
    .filter(
      ({ update: u }) =>
        !metadata.includes(u.sessionUpdate) &&
        u.sessionUpdate !== "state_update",
    )
    .map(({ update: u }) => {
      if (
        [
          "user_message_chunk",
          "agent_message_chunk",
          "agent_thought_chunk",
          "user_message",
          "agent_message",
          "agent_thought",
        ].includes(u.sessionUpdate)
      )
        return [u.sessionUpdate, u.messageId, u.content];
      if (u.toolCallId) return tool(u);
      assert.equal(u.sessionUpdate, "usage_update", "unexpected replay update");
      return ["usage_update", u.used, u.size, optional(u.cost)];
    });
  assert.deepEqual(
    actual,
    expected,
    "changed, duplicated or reordered durable history",
  );
  const states = updates.filter(
    ({ update: u }) => u.sessionUpdate === "state_update",
  );
  assert.equal(states.length, version === 1 ? 0 : 1);
  if (version === 2) {
    assert.equal(states[0].update.state, "idle");
    assert.equal(
      states[0].update.stopReason,
      { completed: "end_turn", failed: "_failed", unresolved: "_unresolved" }[
        saved.run.state
      ],
    );
    const position = updates.indexOf(states[0]);
    assert(
      updates
        .slice(position + 1)
        .every(({ update: u }) => metadata.includes(u.sessionUpdate)),
      "idle preceded history",
    );
  }
}
