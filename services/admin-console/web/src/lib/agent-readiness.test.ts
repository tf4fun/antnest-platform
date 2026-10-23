import assert from "node:assert/strict";
import test from "node:test";
import {
  agentActionAvailability,
  agentFleetCounts,
  agentStatusPresentation,
  selectAgentSnapshot,
} from "./agent-fleet.ts";
import type { Agent } from "./types.ts";

type Readiness = "preparing" | "ready" | "unavailable";
type ReadinessAgent = Agent & { readiness?: Readiness };

function agent(overrides: Partial<ReadinessAgent> = {}): ReadinessAgent {
  return {
    agent_id: "agent-1",
    owner_user_id: "owner-1",
    name: "Agent",
    desired_state: "enabled",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
    agent_spec_revision: "spec-1",
    executable_execution_revision: "execution-1",
    last_successful_execution_revision: "execution-1",
    runtime: { runtime_revision: "runtime-1" },
    aggregate_sequence: 5,
    created_at: "2026-10-23T00:00:00Z",
    updated_at: "2026-10-23T00:00:01Z",
    ...overrides,
  };
}

const readinessValues: (Readiness | undefined)[] = ["ready", "preparing", "unavailable", undefined];

for (const entry of [
  { readiness: "ready", lifecycle: "available", counts: { available: 1, disabled: 0, attention: 0, pending: 0 } },
  { readiness: "preparing", lifecycle: "preparing", counts: { available: 0, disabled: 0, attention: 0, pending: 1 } },
  { readiness: "unavailable", lifecycle: "unavailable", counts: { available: 0, disabled: 0, attention: 1, pending: 0 } },
  { readiness: undefined, lifecycle: "unknown", counts: { available: 0, disabled: 0, attention: 0, pending: 1 } },
] satisfies { readiness: Readiness | undefined; lifecycle: string; counts: ReturnType<typeof agentFleetCounts> }[]) {
  test(`created enabled Agent uses current ${entry.readiness ?? "omitted"} readiness`, () => {
    const source = agent(entry.readiness === undefined ? {} : { readiness: entry.readiness });
    assert.deepEqual(agentStatusPresentation(source), { lifecycle: entry.lifecycle });
    assert.deepEqual(agentFleetCounts([source]), entry.counts);
  });
}

test("Runtime health and complete binding never supply missing Controller readiness", () => {
  for (const executable_execution_revision of [undefined, "execution-1"]) {
    const source = agent({ executable_execution_revision });
    assert.equal(Object.hasOwn(source, "readiness"), false);
    assert.deepEqual(agentStatusPresentation(source), { lifecycle: "unknown" });
    assert.deepEqual(agentFleetCounts([source]), { available: 0, disabled: 0, attention: 0, pending: 1 });
    assert.equal(Object.hasOwn(source, "readiness"), false);
  }
});

test("preparing remains pending when retained lifecycle failure diagnostics exist", () => {
  for (const failure_code of ["runtime_update_failed", "runtime_missing", "image_missing"]) {
    for (const runtime_state of ["available", "waiting"]) {
      const source = agent({
        readiness: "preparing", runtime_state, failure_stage: "runtime_prepare", failure_code,
      });
      assert.deepEqual(agentStatusPresentation(source), { lifecycle: "preparing" });
      assert.deepEqual(agentFleetCounts([source]), { available: 0, disabled: 0, attention: 0, pending: 1 });
      assert.equal(source.failure_code, failure_code);
    }
  }
});

test("disabled confirmation and lifecycle transitions retain priority over readiness", () => {
  for (const readiness of readinessValues) {
    const disabled = agent({ readiness, desired_state: "disabled", activation_state: "disabled" });
    assert.deepEqual(agentStatusPresentation(disabled), { lifecycle: "disabled" });
    assert.deepEqual(agentFleetCounts([disabled]), { available: 0, disabled: 1, attention: 0, pending: 0 });
  }
  for (const lifecycle_state of ["not_created", "creating", "rebuilding", "deleting", "deleted", "quarantined"]) {
    const source = agent({ readiness: "ready", lifecycle_state });
    assert.equal(agentStatusPresentation(source).lifecycle, lifecycle_state);
  }
  assert.deepEqual(
    agentStatusPresentation(agent({ readiness: "preparing", desired_state: "disabled" })),
    { lifecycle: "preparing", target: "Disabled" },
  );
});

test("readiness does not change management lifecycle preconditions or bypass an active operation", () => {
  const enabledActions = { retained: false, canRebuild: true, canEnable: false, canDisable: true, canDelete: true };
  const disabledActions = { retained: false, canRebuild: false, canEnable: true, canDisable: false, canDelete: true };
  const blockedActions = { retained: false, canRebuild: false, canEnable: false, canDisable: false, canDelete: false };
  for (const readiness of readinessValues) {
    const source = agent({ readiness });
    assert.deepEqual(agentActionAvailability(source, false), enabledActions);
    assert.deepEqual(agentActionAvailability(source, true), blockedActions);
    assert.deepEqual(agentActionAvailability({ ...source, active_operation_request_id: "rebuild-1" }, false), blockedActions);
    assert.deepEqual(
      agentActionAvailability({ ...source, desired_state: "disabled", activation_state: "disabled" }, false),
      disabledActions,
    );
    assert.deepEqual(
      agentActionAvailability({ ...source, desired_state: "deleted", lifecycle_state: "deleted" }, false),
      { ...blockedActions, retained: true },
    );
    assert.equal(agentActionAvailability({ ...source, agent_spec_revision: undefined }, false).canRebuild, false);
    assert.equal(agentActionAvailability({ ...source, runtime: undefined }, false).canRebuild, false);
  }
});

for (const transition of [
  { from: "preparing", to: "ready", lifecycle: "available" },
  { from: "ready", to: "preparing", lifecycle: "preparing" },
  { from: "ready", to: "unavailable", lifecycle: "unavailable" },
] satisfies { from: Readiness; to: Readiness; lifecycle: string }[]) {
  test(`same aggregate sequence accepts current readiness ${transition.from} to ${transition.to}`, () => {
    const current = agent({ readiness: transition.from });
    const incoming = agent({ readiness: transition.to });
    assert.equal(incoming.aggregate_sequence, current.aggregate_sequence);
    assert.equal(incoming.updated_at, current.updated_at);
    assert.equal(selectAgentSnapshot(current, incoming), incoming);
    assert.equal(agentStatusPresentation(selectAgentSnapshot(current, incoming)).lifecycle, transition.lifecycle);
    const stale = agent({ readiness: transition.to, aggregate_sequence: current.aggregate_sequence - 1 });
    assert.equal(selectAgentSnapshot(current, stale), current);
    const newer = agent({ readiness: transition.to, aggregate_sequence: current.aggregate_sequence + 1 });
    assert.equal(selectAgentSnapshot(current, newer), newer);
    assert.equal(selectAgentSnapshot(undefined, incoming), incoming);
  });
}
