import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompletedRun,
  assertEmptySession,
} from "./acp-session-evidence.mjs";

for (const version of [1, 2])
  test(`v${version}: empty Session permits only its command catalog and idle control state`, () => {
    const catalog = {
      sessionId: "s",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help", description: "Also /帮助" }],
      },
    };
    const idle = {
      sessionId: "s",
      update: { sessionUpdate: "state_update", state: "idle" },
    };
    const info = {
      sessionId: "s",
      update: {
        sessionUpdate: "session_info_update",
        title: null,
        updatedAt: "2026-09-17T00:00:00.000Z",
      },
    };
    const valid = version === 1 ? [info, catalog] : [info, idle, catalog];
    assertEmptySession([info, catalog], "s", version, "new");
    for (const update of [
      { ...info.update, title: "denied prompt" },
      { ...info.update, updatedAt: "invalid" },
      { ...info.update, extra: "private" },
    ])
      assert.throws(() =>
        assertEmptySession([{ ...info, update }, catalog], "s", version, "new"),
      );
    assert.throws(() =>
      assertEmptySession([...valid, info], "s", version, "replay"),
    );
    assertEmptySession(valid, "s", version, "replay");
    assert.throws(() =>
      assertEmptySession([idle, catalog], "s", version, "new"),
    );
    if (version === 2) {
      assert.throws(() =>
        assertEmptySession([catalog], "s", version, "replay"),
      );
      for (const update of [
        { ...idle.update, state: "running" },
        { ...idle.update, stopReason: "end_turn" },
      ])
        assert.throws(
          () =>
            assertEmptySession(
              [info, { ...idle, update }, catalog],
              "s",
              version,
              "replay",
            ),
          /rejected prompt entered Session history or execution/,
        );
    }
    for (const type of [
      "user_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "usage_update",
      "config_option_update",
    ])
      assert.throws(() =>
        assertEmptySession(
          [...valid, { sessionId: "s", update: { sessionUpdate: type } }],
          "s",
          version,
          "replay",
        ),
      );
    assert.throws(() => assertEmptySession([], "s", version, "replay"));
    assert.throws(() =>
      assertEmptySession([...valid, catalog], "s", version, "replay"),
    );
    assert.throws(() =>
      assertEmptySession(valid, "foreign", version, "replay"),
    );
    assert.throws(() =>
      assertEmptySession(
        [...valid, { ...idle, update: { ...idle.update, state: "running" } }],
        "s",
        version,
        "replay",
      ),
    );
  });

test("completed Run requires same execution, quiescent executor, no cancellation and one settled Tool", () => {
  const running = {
    id: "run",
    request_id: "request",
    execution_snapshot: { execution_revision: "revision" },
  };
  const run = {
    ...running,
    state: "completed",
    terminal_class: "completed",
    stop_reason: "end_turn",
    error_class: null,
    cancel_requested_at: null,
    executor_state: "quiescent",
    tool_effect_state: "settled",
    unknown_effect_source: null,
  };
  const tools = [
    { run_id: "run", state: "completed", runtime_call_stopped: true },
  ];
  assertCompletedRun(run, running, tools);
  for (const fields of [
    { id: "other" },
    { request_id: "other" },
    { execution_snapshot: { execution_revision: "other" } },
    { state: "failed" },
    { terminal_class: "cancelled" },
    { stop_reason: "refusal" },
    { error_class: "lost" },
    { executor_state: "unknown" },
    { tool_effect_state: "unknown" },
    { unknown_effect_source: "runtime" },
    { cancel_requested_at: "date" },
  ])
    assert.throws(() =>
      assertCompletedRun({ ...run, ...fields }, running, tools),
    );
  for (const invalid of [[], [...tools, ...tools], [{ state: "unresolved" }]])
    assert.throws(() => assertCompletedRun(run, running, invalid));
});

test("completed Runtime Tool must belong to the Run and have stopping evidence", () => {
  const r = {
    id: "run",
    request_id: "request",
    execution_snapshot: { id: "same" },
    state: "completed",
    terminal_class: "completed",
    stop_reason: "end_turn",
    error_class: null,
    cancel_requested_at: null,
    executor_state: "quiescent",
    tool_effect_state: "settled",
    unknown_effect_source: null,
  };
  for (const t of [
    { run_id: "foreign", state: "completed", runtime_call_stopped: true },
    { run_id: "run", state: "completed", runtime_call_stopped: false },
  ])
    assert.throws(() => assertCompletedRun(r, r, [t]));
});
