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

function runtimeFixture() {
  return {
    observed: {
      agent: { agent_id: "agent", runtime: { runtime_revision: "revision" } },
      container: {
        Config: {
          Labels: {
            "io.antnest.agent-id": "agent",
            "io.antnest.runtime-generation": "3",
          },
        },
      },
    },
    status: {
      status: "ready",
      agent_id: "agent",
      generation: 3,
      execution_id: "process",
    },
  };
}

test("Runtime execution identity binds the ready process to the observed Agent and container generation", () => {
  const { observed, status } = runtimeFixture();
  assert.deepEqual(runtimeBinding(observed, status), {
    runtime_revision: "revision",
    runtime_execution_id: "process",
  });
});

for (const [label, mutate] of Object.entries({
  foreign_status_agent: (f) => (f.status.agent_id = "foreign"),
  missing_status_agent: (f) => delete f.status.agent_id,
  foreign_container_agent: (f) =>
    (f.observed.container.Config.Labels["io.antnest.agent-id"] = "foreign"),
  missing_generation: (f) => delete f.status.generation,
  foreign_generation: (f) => (f.status.generation = 4),
  string_generation: (f) => (f.status.generation = "3"),
  zero_generation: (f) => (f.status.generation = 0),
  fractional_generation: (f) => (f.status.generation = 3.5),
  unsafe_generation: (f) => (f.status.generation = Number.MAX_SAFE_INTEGER + 1),
  missing_container_generation: (f) =>
    delete f.observed.container.Config.Labels["io.antnest.runtime-generation"],
  noncanonical_container_generation: (f) =>
    (f.observed.container.Config.Labels["io.antnest.runtime-generation"] =
      "03"),
  starting_process: (f) => (f.status.status = "starting"),
  missing_execution_id: (f) => delete f.status.execution_id,
  empty_execution_id: (f) => (f.status.execution_id = ""),
  blank_execution_id: (f) => (f.status.execution_id = " \n"),
  missing_runtime_revision: (f) =>
    delete f.observed.agent.runtime.runtime_revision,
  blank_runtime_revision: (f) =>
    (f.observed.agent.runtime.runtime_revision = " \n"),
}))
  test(`Runtime binding rejects ${label}`, () => {
    const fixture = runtimeFixture();
    mutate(fixture);
    assert.throws(() => runtimeBinding(fixture.observed, fixture.status));
  });
