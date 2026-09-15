import assert from "node:assert/strict";
import test from "node:test";
import { readWorkspaceRoute, workspacePath, selectWorkspaceRoute } from "./navigation.ts";
import { workspaceFromBootstrap } from "./bootstrap.ts";

test("routes encode Agent and Session identifiers, not a project or cwd", () => {
  assert.equal(workspacePath({ agentId: "a/1", sessionId: "s &1" }), "/workspace/?agent=a%2F1&session=s+%261");
  assert.deepEqual(readWorkspaceRoute("?agent=a%2F1&session=s+%261"), { agentId: "a/1", sessionId: "s &1" });
  assert.deepEqual(readWorkspaceRoute("?session=s1&cwd=/tmp"), { agentId: "", sessionId: null });
  assert.equal(workspacePath({ agentId: "", sessionId: "s1" }), "/workspace/");
});

test("selection is explicit, scoped and never falls back from an unknown Agent", () => {
  const snapshot = workspaceFromBootstrap({ principal: { user_id: "u", organization_id: "o", administrator: true },
    agents: [{ agent_id: "a1", name: "One" }, { agent_id: "a2", name: "Two" }] });
  assert.equal(selectWorkspaceRoute(snapshot, { agentId: "", sessionId: null }).activeAgentId, "");
  assert.equal(selectWorkspaceRoute(snapshot, { agentId: "unknown", sessionId: "s" }).activeAgentId, "");
  const selected = selectWorkspaceRoute(snapshot, { agentId: "a2", sessionId: "s2" });
  assert.equal(selected.activeAgentId, "a2");
  assert.equal(selected.activeConversationId, "s2");
});

test("ambiguous and malformed identifiers cannot choose an Agent", () => {
  for (const query of ["?agent=a1&agent=a2", "?agent=%00", `?agent=${"a".repeat(201)}`]) {
    assert.equal(readWorkspaceRoute(query).agentId, "");
  }
});
