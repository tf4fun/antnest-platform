import assert from "node:assert/strict";
import test from "node:test";
import {
  agentActionAvailability,
  agentEventLabel,
  agentStatusPresentation,
  agentsForView,
  agentOwnerView,
  latestOperationRequestID,
  mergeAgentEvents,
  reconcileAgentOperation,
  recoveryOperationRequestID,
  selectAgentSnapshot,
} from "./agent-fleet.ts";
import type { Agent, AgentEvent, DirectoryMember, LifecycleOperation } from "./types.ts";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "agent-1",
    owner_user_id: "user-1",
    name: "Operations Agent",
    desired_state: "enabled",
    lifecycle_state: "available",
    aggregate_sequence: 1,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

function event(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    event_id: "event-1",
    global_sequence: 1,
    aggregate_sequence: 1,
    schema_version: 1,
    agent_id: "agent-1",
    event_type: "agent_ready",
    occurred_at: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

test("Agent fleet keeps retained records behind the explicit deleted view", () => {
  const current = agent();
  const deleted = agent({
    agent_id: "agent-deleted",
    desired_state: "deleted",
    lifecycle_state: "deleted",
  });

  assert.deepEqual(agentsForView([current, deleted], "current"), [current]);
  assert.deepEqual(agentsForView([current, deleted], "deleted"), [deleted]);
});

test("Agent owner choices exclude inactive members without erasing historical identity", () => {
  const active = member("active", true, true);
  const inactiveUser = member("inactive-user", false, true);
  const inactiveMembership = member("inactive-membership", true, false);

  const owners = agentOwnerView([active, inactiveUser, inactiveMembership]);

  assert.deepEqual(owners.selectable, [active]);
  assert.equal(owners.byUserID.get("user-inactive-user")?.membership.display_name, "inactive-user");
  assert.equal(
    owners.byUserID.get("user-inactive-membership")?.membership.display_name,
    "inactive-membership",
  );
});

test("Agent actions follow lifecycle preconditions instead of optimistic UI guesses", () => {
  assert.deepEqual(agentActionAvailability(agent(), false), {
    retained: false,
    canRebuild: true,
    canEnable: false,
    canDisable: true,
    canDelete: true,
  });
  assert.deepEqual(
    agentActionAvailability(
      agent({ desired_state: "disabled", lifecycle_state: "disabled" }),
      false,
    ),
    {
      retained: false,
      canRebuild: false,
      canEnable: true,
      canDisable: false,
      canDelete: true,
    },
  );
  assert.deepEqual(
    agentActionAvailability(
      agent({ desired_state: "deleted", lifecycle_state: "deleted" }),
      false,
    ),
    {
      retained: true,
      canRebuild: false,
      canEnable: false,
      canDisable: false,
      canDelete: false,
    },
  );
  assert.equal(agentActionAvailability(agent(), true).canDelete, false);
  assert.equal(
    agentActionAvailability(
      agent({ desired_state: "deleted", lifecycle_state: "deleting" }),
      false,
    ).retained,
    false,
  );
  assert.equal(
    agentActionAvailability(agent({ lifecycle_state: "unavailable" }), false).canRebuild,
    false,
  );
});

test("resynchronization follows the newest operation-bearing lifecycle event", () => {
  assert.equal(
    latestOperationRequestID([
      event({ global_sequence: 7, operation_request_id: "operation-old" }),
      event({ global_sequence: 9 }),
      event({ global_sequence: 8, operation_request_id: "operation-new" }),
    ]),
    "operation-new",
  );
  assert.equal(latestOperationRequestID([event({})]), undefined);
});

test("event recovery preserves loaded history and de-duplicates replayed events", () => {
  const existing = event({ event_id: "event-1", global_sequence: 1 });
  const replayed = event({ event_id: "event-1", global_sequence: 1 });
  const next = event({ event_id: "event-2", global_sequence: 2 });

  assert.deepEqual(mergeAgentEvents([existing], [replayed, next]), [existing, next]);
});

test("event recovery follows the Agent's authoritative active operation", () => {
  assert.equal(
    recoveryOperationRequestID(
      agent({ active_operation_request_id: "operation-active" }),
      [event({ global_sequence: 8, operation_request_id: "operation-replayed" })],
    ),
    "operation-active",
  );
});

test("event recovery falls back to the newest replayed operation when the Agent is idle", () => {
  assert.equal(
    recoveryOperationRequestID(agent(), [
      event({ global_sequence: 7, operation_request_id: "operation-old" }),
      event({ global_sequence: 9 }),
      event({ global_sequence: 8, operation_request_id: "operation-new" }),
    ]),
    "operation-new",
  );
});

test("active operation reconciliation never presents another request as current", () => {
  const stale = operation({ request_id: "operation-old", state: "running" });

  assert.equal(reconcileAgentOperation("operation-new", stale), undefined);
  assert.equal(reconcileAgentOperation("operation-old", stale), stale);
});

test("an idle Agent clears stale running state but retains terminal operation evidence", () => {
  assert.equal(
    reconcileAgentOperation(undefined, operation({ state: "running" })),
    undefined,
  );
  const completed = operation({ state: "completed", phase: "completed" });
  assert.equal(reconcileAgentOperation(undefined, completed), completed);
});

test("Agent status suppresses a desired state that already matches lifecycle", () => {
  assert.deepEqual(agentStatusPresentation(agent()), {
    lifecycle: "available",
  });
  assert.deepEqual(
    agentStatusPresentation(
      agent({ desired_state: "disabled", lifecycle_state: "disabled" }),
    ),
    { lifecycle: "disabled" },
  );
  assert.deepEqual(
    agentStatusPresentation(
      agent({ desired_state: "deleted", lifecycle_state: "deleted" }),
    ),
    { lifecycle: "deleted" },
  );
});

test("Agent snapshot selection accepts progress and rejects out-of-order regressions", () => {
  const current = agent({ aggregate_sequence: 5, lifecycle_state: "available" });
  const stale = agent({ aggregate_sequence: 4, lifecycle_state: "provisioning" });
  const next = agent({ aggregate_sequence: 6, lifecycle_state: "disabled" });

  assert.equal(selectAgentSnapshot(current, stale), current);
  assert.equal(selectAgentSnapshot(current, next), next);
});

test("Agent status exposes the target only while lifecycle has not converged", () => {
  assert.deepEqual(
    agentStatusPresentation(
      agent({ desired_state: "disabled", lifecycle_state: "available" }),
    ),
    { lifecycle: "available", target: "Disabled" },
  );
  assert.deepEqual(
    agentStatusPresentation(
      agent({ desired_state: "deleted", lifecycle_state: "deleting" }),
    ),
    { lifecycle: "deleting", target: "Deleted" },
  );
});

test("lifecycle event labels describe the administrator-visible action", () => {
  assert.equal(agentEventLabel("agent_create_requested"), "Creation requested");
  assert.equal(agentEventLabel("agent_ready"), "Agent available");
  assert.equal(agentEventLabel("agent_rebuilt"), "Rebuild completed");
  assert.equal(agentEventLabel("agent_lifecycle_quarantined"), "Lifecycle quarantined");
  assert.equal(agentEventLabel("future_event_name"), "Future event name");
});

function member(id: string, userActive: boolean, membershipActive: boolean): DirectoryMember {
  return {
    user: {
      id: `user-${id}`,
      system_role: "member",
      active: userActive,
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    },
    membership: {
      id: `membership-${id}`,
      user_id: `user-${id}`,
      email: `${id}@example.com`,
      display_name: id,
      role: "member",
      source: "local",
      active: membershipActive,
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    },
  };
}

function operation(overrides: Partial<LifecycleOperation> = {}): LifecycleOperation {
  return {
    request_id: "operation-1",
    agent_id: "agent-1",
    kind: "rebuild",
    phase: "runtime_starting",
    state: "running",
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}
