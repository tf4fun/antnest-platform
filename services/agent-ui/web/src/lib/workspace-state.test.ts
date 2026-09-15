import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceState } from "./workspace-state.ts";

const ready = { agent_id: "a1", availability: "ready", access_allowed: true,
  configuration_revision: "a".repeat(64), unavailable_reason: null, active_session_id: null };
const denied = { ...ready, availability: "offline", access_allowed: false,
  configuration_revision: null, unavailable_reason: "access_denied" };

test("ACP snapshots preserve configuration identity, scoped busy Session and access loss", () => {
  for (const state of [ready, { ...ready, availability: "busy", active_session_id: "s1" }, denied,
    { ...ready, availability: "offline", unavailable_reason: "runtime_barrier_required" },
    { ...ready, availability: "busy", unavailable_reason: "agent_unavailable", active_session_id: "s1" }]) {
    assert.deepEqual(parseWorkspaceState(JSON.stringify(state), "a1"), state);
  }
});

test("obsolete, foreign and contradictory snapshots fail closed", () => {
  for (const state of [null, {}, { ...ready, agent_revision: 1 }, { ...ready, agent_id: "other" },
    { ...ready, configuration_revision: null }, { ...ready, configuration_revision: "bad" },
    { ...ready, unavailable_reason: "agent_unavailable" }, { ...ready, active_session_id: "s1" },
    { ...ready, active_session_id: undefined }, { ...ready, availability: "busy", active_session_id: " " },
    { ...ready, access_allowed: false }, { ...denied, active_session_id: "s1" }]) {
    assert.throws(() => parseWorkspaceState(JSON.stringify(state), "a1"));
  }
  assert.throws(() => parseWorkspaceState("x".repeat(65537), "a1"));
});
