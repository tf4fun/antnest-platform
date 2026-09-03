import assert from "node:assert/strict";
import test from "node:test";
import { workspaceFromBootstrap } from "./bootstrap.ts";

test("maps the safe Edge bootstrap without inventing access credentials", () => {
  const workspace = workspaceFromBootstrap({
    principal: {
      user_id: "user-1",
      organization_id: "org-1",
      administrator: false,
    },
    agents: [
      { agent_id: "agent-1", name: "Research", availability: "busy" },
    ],
  });

  assert.equal(workspace.principal.displayName, "Signed in");
  assert.equal(workspace.principal.organizationName, "Organization workspace");
  assert.equal(workspace.activeAgentId, "agent-1");
  assert.equal(workspace.agents[0]?.status, "busy");
  assert.equal(workspace.connection, "connecting");
  assert.equal("agent_access_subject" in workspace.agents[0]!, false);
});

test("rejects unknown availability instead of weakening the UI state model", () => {
  assert.throws(() => workspaceFromBootstrap({
    principal: {
      user_id: "user-1",
      organization_id: "org-1",
      administrator: true,
    },
    agents: [{ agent_id: "agent-1", name: "Research", availability: "working" }],
  }));
});
