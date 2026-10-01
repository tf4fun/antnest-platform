import assert from "node:assert/strict";
import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const sessionId = process.env.ANTNEST_E2E_SESSION_ID;
assert(agentId && sessionId);
const member = new GatewayClient("http://edge-gateway:8080");
await member.request("/api/session/login", {
  body: {
    organization_slug: "stage3",
    email: "c4-member@example.com",
    password: "c4-member-password",
  },
});
const client = connectACP(1, agentId, member.cookie);
try {
  await client.initialize();
  await until(
    async () => {
      try {
        return await client.request("load", {
          cwd: "/workspace",
          mcpServers: [],
          sessionId,
        });
      } catch (error) {
        if (error?.data?.code === "configuration_not_ready") return null;
        throw error;
      }
    },
    "Controller execution configuration republished after ACP restart",
    undefined,
    90_000,
  );
  const result = await client.request(
    "prompt",
    { sessionId, prompt: [{ type: "text", text: "foreground during review" }] },
    30_000,
  );
  assert.equal(result.stopReason, "end_turn");
  const model = await fetch("http://stage3-model:8080/status").then(
    (response) => response.json(),
  );
  assert.deepEqual(model.errors, []);
  assert.deepEqual(model.pending, []);
  assert.deepEqual(
    model.requests.filter((kind) => kind === "review-create"),
    ["review-create"],
  );
  assert(model.cancelled.includes("review-create"));
  assert(model.requests.includes("foreground-preempt-reply"));
  console.log(
    JSON.stringify({
      status: "foreground_after_acp_restart",
      agent_id: agentId,
      session_id: sessionId,
    }),
  );
} finally {
  client.close();
}
