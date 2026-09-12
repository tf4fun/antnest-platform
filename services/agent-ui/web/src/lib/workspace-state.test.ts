import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceState } from "./workspace-state.ts";

const ready = { agent_id: "a1", availability: "ready", access_allowed: true, agent_revision: 1, active_session_id: null };

test("state snapshots preserve scoped busy Session and terminal access loss", () => {
  assert.deepEqual(parseWorkspaceState(JSON.stringify(ready), "a1"), ready);
  const busy = { ...ready, availability: "busy", active_session_id: "s1" };
  assert.deepEqual(parseWorkspaceState(JSON.stringify(busy), "a1"), busy);
  assert.equal(parseWorkspaceState(JSON.stringify({ ...ready, availability: "offline", access_allowed: false }), "a1").access_allowed, false);
});

test("invalid, foreign, excessive and contradictory snapshots fail closed", () => {
  for (const candidate of [null, {}, { ...ready, private: "secret" }, { ...ready, agent_id: "other" },
    { ...ready, agent_revision: 0 }, { ...ready, agent_revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...ready, active_session_id: "s1" }, { ...ready, active_session_id: undefined },
    { ...ready, availability: "busy", active_session_id: " " }, { ...ready, access_allowed: false }]) {
    assert.throws(() => parseWorkspaceState(JSON.stringify(candidate), "a1"));
  }
  assert.throws(() => parseWorkspaceState("x".repeat(65537), "a1"));
});
