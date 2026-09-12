import assert from "node:assert/strict";
import test from "node:test";
import { cleanupPermissionAgents } from "./cleanup.mjs";

const id = "ed553afe-c9e0-4821-a4ef-5104e9c6301c";
function fixture(failFirst = false) {
  const effects = [];
  const cancelled = [];
  const agents = [1, 2].map((version) => ({
    agent_id: `agent-${version}`,
    name: `Permissions v${version} ${id}`,
  }));
  const api = async (path, body) => {
    if (path.startsWith("/api/admin/agents?")) {
      return path.includes("cursor=")
        ? { items: [agents[1]], next_cursor: null }
        : {
            items: [
              agents[0],
              { agent_id: "unrelated", name: "Existing Agent" },
            ],
            next_cursor: "page2",
          };
    }
    if (path.endsWith("/delete")) {
      effects.push(path);
      if (failFirst && path.includes("agent-1"))
        throw new Error("first cleanup failed");
      assert.deepEqual(body, {});
      return { request_id: path.includes("agent-1") ? "op1" : "op2" };
    }
    if (path.startsWith("/api/admin/operations/"))
      return { state: "completed" };
    return {
      ...agents.find((agent) => path.endsWith(agent.agent_id)),
      lifecycle_state: "available",
    };
  };
  return {
    api,
    effects,
    cancelled,
    cancel: async (agent) => cancelled.push(agent),
  };
}
test("independent cleanup discovers only this invocation across pages without client memory", async () => {
  const f = fixture();
  await cleanupPermissionAgents(f.api, id, f.cancel);
  assert.deepEqual(f.cancelled, ["agent-1", "agent-2"]);
  assert.equal(f.effects.length, 2);
});
test("cleanup attempts all owned Agents and fails rather than hiding partial failure", async () => {
  const f = fixture(true);
  await assert.rejects(
    cleanupPermissionAgents(f.api, id, f.cancel),
    AggregateError,
  );
  assert.equal(f.effects.length, 2);
});
test("missing ownership scope cannot trigger deletion", async () => {
  const f = fixture();
  await assert.rejects(cleanupPermissionAgents(f.api, "", f.cancel));
  assert.deepEqual(f.effects, []);
});
