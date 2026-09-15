import assert from "node:assert/strict";
import test from "node:test";
import { workspaceFromBootstrap } from "./bootstrap.ts";

const principal = { user_id: "user-1", organization_id: "org-1", administrator: false };

test("accepts metadata-only discovery without inventing availability or selecting an Agent", () => {
  const workspace = workspaceFromBootstrap({ principal, agents: [{ agent_id: "agent-1", name: "Research" }] });
  assert.equal(workspace.activeAgentId, "");
  assert.equal(workspace.activeConversationId, null);
  assert.equal(workspace.agents[0]?.status, "unknown");
  assert.equal(workspace.principal.userId, "user-1");
  assert.equal("agent_access_subject" in workspace.agents[0]!, false);
});

test("rejects malformed and duplicate Agent discovery entries", () => {
  for (const agents of [[{ agent_id: "", name: "Research" }], [{ agent_id: "a1", name: "" }],
    [{ agent_id: "a1", name: "One" }, { agent_id: "a1", name: "Two" }]]) {
    assert.throws(() => workspaceFromBootstrap({ principal, agents }));
  }
});
