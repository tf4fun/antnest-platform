import assert from "node:assert/strict";
import test from "node:test";
import { readWorkspaceRoute, workspacePath, selectWorkspaceRoute } from "./navigation.ts";
import { workspaceFromBootstrap } from "./bootstrap.ts";

test("routes express workspace and Session hierarchy with independently encoded identifiers", () => {
  assert.equal(workspacePath({ agentId: "a/1", sessionId: "s &1" }), "/workspace/a%2F1/sessions/s%20%261");
  assert.deepEqual(readWorkspaceRoute("/workspace/a%2F1/sessions/s%20%261"), { agentId: "a/1", sessionId: "s &1" });
  assert.equal(workspacePath({ agentId: "a1", sessionId: null }), "/workspace/a1/");
  assert.deepEqual(readWorkspaceRoute("/workspace/a1/"), { agentId: "a1", sessionId: null });
  assert.deepEqual(readWorkspaceRoute("/workspace/"), { agentId: "", sessionId: null });
  assert.equal(workspacePath({ agentId: "", sessionId: "s1" }), "/workspace/");
});

test("selection is explicit, scoped and never falls back from an unknown Agent", () => {
  const snapshot = workspaceFromBootstrap({ principal: { user_id: "u", organization_id: "o", administrator: true },
    agents: [{ agent_id: "a1", name: "One", lifecycle_state: "created", activation_state: "enabled", runtime_state: "available" },
      { agent_id: "a2", name: "Two", lifecycle_state: "created", activation_state: "disabled", runtime_state: "exited" }] });
  assert.equal(selectWorkspaceRoute(snapshot, { agentId: "", sessionId: null }).activeAgentId, "");
  assert.equal(selectWorkspaceRoute(snapshot, { agentId: "unknown", sessionId: "s" }).activeAgentId, "");
  const selected = selectWorkspaceRoute(snapshot, { agentId: "a2", sessionId: "s2" });
  assert.equal(selected.activeAgentId, "a2");
  assert.equal(selected.activeConversationId, "s2");
});

test("selecting another Session releases completed process from the workspace cache", () => {
  const base = workspaceFromBootstrap({ principal: { user_id: "u", organization_id: "o", administrator: true },
    agents: [{ agent_id: "a1", name: "One", lifecycle_state: "created",
      activation_state: "enabled", runtime_state: "available" }] });
  const selected = selectWorkspaceRoute({ ...base, activeAgentId: "a1",
    activeConversationId: "s1", conversations: [{ id: "s1", agentId: "a1", title: "One",
      updatedAt: "now", messages: [
        { id: "turn:prompt", role: "user", content: "Question",
          turnOutcome: "completed", processCount: 1, processLoaded: true },
        { id: "turn:process:tool", role: "assistant", content: "large result" },
        { id: "turn:answer", role: "assistant", content: "Answer" },
      ] }] }, { agentId: "a1", sessionId: "s2" });
  assert.equal(selected.activeConversationId, "s2");
  assert.deepEqual(selected.conversations[0]?.messages.map((item) => item.id),
    ["turn:prompt", "turn:answer"]);
});

test("malformed routes, queries, assets and dot segments cannot choose an Agent", () => {
  for (const path of ["/workspace/?agent=a1", "/workspace/a1/?session=s1", "/workspace/a1/sessions/",
    "/workspace/a1/sessions/s1/extra", "/workspace/%00/", "/workspace/%E0%A4/", "/workspace/../",
    "/workspace/%2e%2e/", "/workspace/a1/sessions/%2E", "/workspace/assets/", "/workspace/assets/app.js",
    "/workspace/a1/#fragment", "/workspace/%20a1/", `/${"/workspace/a1/"}`,
    `/workspace/${"a".repeat(201)}/`]) {
    assert.equal(readWorkspaceRoute(path).agentId, "", path);
  }
});
