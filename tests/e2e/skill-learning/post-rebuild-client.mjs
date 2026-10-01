import assert from "node:assert/strict";

import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";

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
  await client.request("load", {
    cwd: "/workspace",
    mcpServers: [],
    sessionId,
  });
  const reply = await client.request(
    "prompt",
    {
      sessionId,
      prompt: [
        { type: "text", text: "verify learned procedure after rebuild" },
      ],
    },
    90_000,
  );
  assert.equal(reply.stopReason, "end_turn");
  const model = await fetch("http://stage3-model:8080/status").then(
    (response) => response.json(),
  );
  assert.deepEqual(model.errors, []);
  assert(model.requests.includes("foreground-rebuild-verify-tool"));
  assert(model.requests.includes("foreground-rebuild-verify-reply"));
  console.log(JSON.stringify({ status: "learned_skill_read_after_rebuild" }));
} finally {
  client.close();
}
