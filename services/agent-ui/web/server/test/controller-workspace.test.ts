import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverWorkspaceAgents } from "../src/adapters/controller-workspace.ts";
import { testScope } from "./support/auth-fixture.ts";

test("Controller discovery pages an authorized scope and stops at the final cursor", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const agents = await discoverWorkspaceAgents({
    baseUrl: new URL("http://controller.internal:8080"),
    scope: testScope({ organizationId: "org-1", principalId: "user-1" }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json(calls.length === 1
        ? { agents: [{ agent_id: "agent-1", name: "First", lifecycle_state: "created", activation_state: "enabled", runtime_state: "available" }], next_cursor: "second" }
        : { agents: [{ agent_id: "agent-2", name: "Second", lifecycle_state: "not_created", runtime_state: "unknown" }], next_cursor: null });
    },
  });
  assert.deepEqual(agents.map((agent) => agent.agent_id), ["agent-1", "agent-2"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "http://controller.internal:8080/rpc/agent-controller/list-workspace-agents");
  assert.equal(calls[0]!.body.organization_id, "org-1");
  assert.equal(calls[0]!.body.principal_id, "user-1");
  assert.equal(calls[0]!.body.limit, 200);
  assert.equal(calls[1]!.body.cursor, "second");
  assert.notEqual(calls[0]!.body.request_id, calls[1]!.body.request_id);
});

test("Controller discovery rejects repeated cursors and partial pages", async () => {
  const input = {
    baseUrl: new URL("http://controller.internal:8080"),
    scope: testScope({ organizationId: "org-1", principalId: "user-1" }),
  };
  await assert.rejects(discoverWorkspaceAgents({
    ...input,
    fetchImpl: async () => Response.json({ agents: [], next_cursor: "again" }),
  }), /cursor/u);
  await assert.rejects(discoverWorkspaceAgents({
    ...input,
    fetchImpl: async () => Response.json({ next_cursor: null }),
  }), /Controller/u);
});
