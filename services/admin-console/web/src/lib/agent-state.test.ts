import assert from "node:assert/strict";
import test from "node:test";
import { agentActionAvailability, agentStatusPresentation, agentFleetCounts } from "./agent-fleet.ts";
import type { Agent } from "./types.ts";

const configured: Agent = {
  agent_id: "a1", name: "Agent", owner_user_id: "u1", desired_state: "enabled",
  lifecycle_state: "created", activation_state: "enabled", runtime_state: "waiting",
  agent_spec_revision: "s1", runtime: { runtime_revision: "r1" }, aggregate_sequence: 3,
  created_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:00:00Z",
};

test("all never-ready conditions permit management without execution history", () => {
  for (const runtime_state of ["waiting", "unhealthy", "exited", "absent", "unknown"]) {
    const agent = { ...configured, runtime_state };
    assert.deepEqual(agentActionAvailability(agent, false), {
      retained: false, canRebuild: true, canEnable: false, canDisable: true, canDelete: true,
    });
    assert.equal(agentStatusPresentation(agent).lifecycle, runtime_state);
  }
});

test("disabled confirmation overrides stale health while disable intent is separate", () => {
  const disabling = { ...configured, desired_state: "disabled", active_operation_request_id: "stop-1" };
  assert.equal(agentStatusPresentation(disabling).target, "Disabled");
  assert.equal(agentActionAvailability(disabling, false).canEnable, false);
  const disabled = { ...configured, desired_state: "disabled", activation_state: "disabled", runtime_state: "available" };
  assert.deepEqual(agentStatusPresentation(disabled), { lifecycle: "disabled" });
  assert.equal(agentActionAvailability(disabled, false).canEnable, true);
});

test("fleet counts do not invent a failed lifecycle or count unbound health as ready", () => {
  const ready = { ...configured, runtime_state: "available", executable_execution_revision: "e1" };
  const records = [ready, configured, { ...configured, runtime_state: "exited" },
    { ...ready, desired_state: "disabled", activation_state: "disabled" },
    { ...ready, active_operation_request_id: "rebuild-1" },
    { ...ready, executable_execution_revision: undefined },
    { ...configured, lifecycle_state: "not_created", activation_state: undefined, failure_code: "image_missing" }];
  assert.deepEqual(agentFleetCounts(records), { available: 1, disabled: 1, attention: 3, pending: 2 });
});
