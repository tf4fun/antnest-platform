import assert from "node:assert/strict";

import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
assert(agentId);

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
  const { sessionId } = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  const reply = await client.request(
    "prompt",
    {
      sessionId,
      prompt: [{ type: "text", text: "foreground during review" }],
    },
    90_000,
  );
  assert.equal(reply.stopReason, "end_turn");
  console.log(JSON.stringify({ status: "foreground_completed_after_enable" }));
} finally {
  client.close();
}
