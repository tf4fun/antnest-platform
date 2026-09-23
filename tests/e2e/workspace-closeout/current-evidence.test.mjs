import assert from "node:assert/strict";
import test from "node:test";
import { assertState } from "./evidence.mjs";
import {
  assertCancelledRun,
  assertUnchangedAudit,
  runtimeBinding,
} from "./current-evidence.mjs";

const ready = {
  agent_id: "agent",
  availability: "ready",
  access_allowed: true,
  configuration_revision: "a".repeat(64),
  unavailable_reason: null,
  active_session_id: null,
};
test("current Workspace states distinguish availability, access and Runtime protection", () => {
  for (const state of [
    ready,
    { ...ready, availability: "busy", active_session_id: "session" },
    {
      ...ready,
      availability: "offline",
      unavailable_reason: "agent_unavailable",
    },
    {
      ...ready,
      availability: "offline",
      unavailable_reason: "runtime_barrier_required",
    },
    {
      ...ready,
      availability: "offline",
      unavailable_reason: "access_denied",
      access_allowed: false,
      configuration_revision: null,
    },
  ])
    assertState(state, "agent");
});
for (const [label, patch] of Object.entries({
  legacy: { agent_revision: 7 },
  missing_hash: { configuration_revision: null },
  numeric_hash: { configuration_revision: 7 },
  malformed_hash: { configuration_revision: "A".repeat(64) },
  foreign: { agent_id: "foreign" },
  ready_active: { active_session_id: "s" },
  ready_reason: { unavailable_reason: "runtime_barrier_required" },
  denied_ready: { access_allowed: false },
  offline_active: {
    availability: "offline",
    active_session_id: "s",
    unavailable_reason: "agent_unavailable",
  },
  offline_reason: { availability: "offline", unavailable_reason: null },
  busy_reason: {
    availability: "busy",
    unavailable_reason: "runtime_barrier_required",
  },
  huge_session: { availability: "busy", active_session_id: "s".repeat(201) },
}))
  test(`state rejects ${label}`, () =>
    assert.throws(() => assertState({ ...ready, ...patch }, "agent")));

const run = {
  run_id: "run",
  agent_id: "agent",
  session_id: "session",
  state: "unresolved",
  terminal_class: "unresolved",
  executor_state: "quiescent",
  tool_effect_state: "unknown",
  error_class: "cancelled_tool_outcome_unknown",
  unknown_effect_source: "runtime_mcp",
  stop_reason: null,
  execution_snapshot: { executionRevision: "execution" },
};
test("cancelled Tool retains unknown effect bound to the actual execution", () => {
  assertCancelledRun(run, "agent", "session", "execution");
  for (const patch of [
    { state: "cancelled" },
    { terminal_class: "cancelled" },
    { executor_state: "unknown" },
    { tool_effect_state: "settled" },
    { error_class: "service_restarted_during_tool" },
    { unknown_effect_source: "client_mcp" },
    { stop_reason: "end_turn" },
    { agent_id: "foreign" },
    { session_id: "foreign" },
    { execution_snapshot: { executionRevision: "foreign" } },
  ])
    assert.throws(() =>
      assertCancelledRun({ ...run, ...patch }, "agent", "session", "execution"),
    );
});
test("recovery and replay cannot rewrite unknown Run or event history", () => {
  const audit = {
    run,
    events: { items: [{ sequence: 1, kind: "tool_call" }], next_cursor: null },
  };
  assertUnchangedAudit(audit, structuredClone(audit));
  for (const mutate of [
    (a) => (a.run.tool_effect_state = "settled"),
    (a) => a.events.items.push({ sequence: 2 }),
    (a) => (a.events.next_cursor = "more"),
    (a) => (a.events.items[0].sequence = 2),
  ]) {
    const after = structuredClone(audit);
    mutate(after);
    assert.throws(() => assertUnchangedAudit(audit, after));
  }
  assert.throws(() =>
    assertUnchangedAudit(
      { ...audit, events: { ...audit.events, next_cursor: "more" } },
      audit,
    ),
  );
});

test("Runtime execution identity comes from the actual ready process, not redacted public Agent fields", () => {
  const observed = {
    agent: { agent_id: "agent", runtime: { runtime_revision: "revision" } },
    container: { Config: { Labels: { "io.antnest.agent-id": "agent" } } },
  };
  assert.deepEqual(
    runtimeBinding(observed, { status: "ready", execution_id: "process" }),
    { runtime_revision: "revision", runtime_execution_id: "process" },
  );
  for (const status of [
    { status: "ready" },
    { status: "starting", execution_id: "process" },
    { status: "ready", execution_id: "" },
  ])
    assert.throws(() => runtimeBinding(observed, status));
  const foreign = structuredClone(observed);
  foreign.container.Config.Labels["io.antnest.agent-id"] = "foreign";
  assert.throws(() =>
    runtimeBinding(foreign, { status: "ready", execution_id: "process" }),
  );
});
