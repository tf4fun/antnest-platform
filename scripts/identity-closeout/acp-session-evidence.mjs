import assert from "node:assert/strict";
import { assertCatalog } from "../acp-commands/evidence.mjs";

export function assertEmptySession(updates, sessionId, version, phase) {
  assert(phase === "new" || phase === "replay", "unknown Session setup phase");
  assertCatalog(updates, sessionId);
  const metadata = updates.filter(
    ({ update }) => update.sessionUpdate === "session_info_update",
  );
  assert.equal(
    metadata.length,
    1,
    "empty Session metadata missing or duplicated",
  );
  assert.equal(metadata[0].sessionId, sessionId);
  const info = metadata[0].update;
  assert.equal(info.title, null, "rejected prompt changed empty Session title");
  assert(
    Number.isFinite(Date.parse(info.updatedAt)),
    "invalid Session update timestamp",
  );
  assert.deepEqual(Object.keys(info).sort(), [
    "sessionUpdate",
    "title",
    "updatedAt",
  ]);
  const states = updates.filter(
    ({ update }) =>
      !["available_commands_update", "session_info_update"].includes(
        update.sessionUpdate,
      ),
  );
  assert.equal(
    states.length,
    version === 2 && phase === "replay" ? 1 : 0,
    "empty Session has missing or unexpected notifications",
  );
  for (const { update } of states)
    assert(
      update.sessionUpdate === "state_update" &&
        update.state === "idle" &&
        update.stopReason === undefined,
      "rejected prompt entered Session history or execution",
    );
}

export function assertCompletedRun(run, accepted, tools) {
  assert(
    run?.id === accepted.id && run.request_id === accepted.request_id,
    "Run/request was replaced",
  );
  assert(
    run.state === "completed" &&
      run.terminal_class === "completed" &&
      run.stop_reason === "end_turn",
    "Run did not complete normally",
  );
  assert(
    run.error_class === null && run.cancel_requested_at === null,
    "Run was cancelled or failed",
  );
  assert(accepted.execution_snapshot, "accepted execution missing");
  assert.deepEqual(
    run.execution_snapshot,
    accepted.execution_snapshot,
    "execution snapshot replaced",
  );
  assert.equal(run.executor_state, "quiescent");
  assert.equal(run.tool_effect_state, "settled");
  assert.equal(run.unknown_effect_source, null);
  assert(
    tools.length === 1 &&
      tools[0].run_id === run.id &&
      tools[0].state === "completed" &&
      tools[0].runtime_call_stopped === true,
    "missing, duplicated or unsettled Tool",
  );
}
