import assert from "node:assert/strict";
import test from "node:test";
import { workspaceFromBootstrap, workspaceFromBridgeBootstrap } from "./bootstrap.ts";

const principal = {
  user_id: "user-1",
  organization_id: "org-1",
  administrator: false,
};

const management = {
  lifecycle_state: "created",
  activation_state: "enabled",
  runtime_state: "available",
};

test("preserves management state without inventing execution availability or selecting an Agent", () => {
  const workspace = workspaceFromBootstrap({
    principal,
    agents: [{ agent_id: "agent-1", name: "Research", ...management }],
  });
  assert.equal(workspace.activeAgentId, "");
  assert.equal(workspace.activeConversationId, null);
  assert.equal(workspace.agents[0]?.status, "unknown");
  assert.deepEqual(workspace.agents[0]?.managementState, {
    lifecycle: "created",
    activation: "enabled",
    runtime: "available",
  });
  assert.equal(workspace.principal.userId, "user-1");
  assert.equal("agent_access_subject" in workspace.agents[0]!, false);
});

test("rejects malformed and duplicate Agent discovery entries", () => {
  for (const agents of [
    [{ agent_id: "", name: "Research", ...management }],
    [{ agent_id: "a1", name: "", ...management }],
    [
      { agent_id: "a1", name: "One", ...management },
      { agent_id: "a1", name: "Two", ...management },
    ],
  ]) {
    assert.throws(() => workspaceFromBootstrap({ principal, agents }));
  }
});

test("keeps every authorized management state in discovery, including uncreated and disabled", () => {
  for (const runtime of [
    "unknown",
    "waiting",
    "available",
    "unhealthy",
    "exited",
    "absent",
  ]) {
    const workspace = workspaceFromBootstrap({
      principal,
      agents: [
        {
          agent_id: "a1",
          name: "Agent",
          ...management,
          activation_state: "disabled",
          runtime_state: runtime,
        },
        {
          agent_id: "a2",
          name: "Pending",
          lifecycle_state: "not_created",
          runtime_state: "unknown",
        },
      ],
    });
    assert.equal(workspace.agents.length, 2);
    assert.equal(workspace.agents[0]?.managementState.runtime, runtime);
    assert.equal(workspace.agents[0]?.managementState.activation, "disabled");
    assert.equal(workspace.agents[1]?.managementState.activation, undefined);
  }
});

test("rejects missing, inconsistent and execution-only management state", () => {
  for (const state of [
    {},
    { ...management, runtime_state: "busy" },
    { ...management, lifecycle_state: "ready" },
    { ...management, activation_state: undefined },
    { ...management, activation_state: null },
    { ...management, lifecycle_state: "not_created" },
  ]) {
    assert.throws(() =>
      workspaceFromBootstrap({
        principal,
        agents: [{ agent_id: "a1", name: "Agent", ...state }],
      }),
    );
  }
});

test("Bridge bootstrap maps the verified principal and Agent directory into the current UI model", () => {
  const workspace = workspaceFromBridgeBootstrap({
    principal: { userId: "user-1", organizationId: "org-1", administrator: true },
    agents: [{ agentId: "agent-1", name: "Research", lifecycle: "created", activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00.000Z", bridgeEpoch: "epoch-1",
  });
  assert.equal(workspace.principal.administrator, true);
  assert.equal(workspace.agents[0]?.id, "agent-1");
  assert.equal(workspace.agents[0]?.status, "unknown");
  assert.equal(workspace.activeAgentId, "");
});

test("Bridge bootstrap rejects duplicate or inconsistent Agent entries", () => {
  const base = {
    principal: { userId: "user-1", organizationId: "org-1", administrator: false },
    renderedAt: "2026-09-23T00:00:00.000Z", bridgeEpoch: "epoch-1",
  };
  assert.throws(() => workspaceFromBridgeBootstrap({ ...base, agents: [
    { agentId: "agent-1", name: "One", lifecycle: "created", activation: "enabled", runtime: "available" },
    { agentId: "agent-1", name: "Two", lifecycle: "created", activation: "enabled", runtime: "available" },
  ] }));
  assert.throws(() => workspaceFromBridgeBootstrap({ ...base, agents: [
    { agentId: "agent-1", name: "One", lifecycle: "not_created", activation: "enabled", runtime: "unknown" },
  ] }));
});
