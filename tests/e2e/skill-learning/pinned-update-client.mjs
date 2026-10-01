import assert from "node:assert/strict";

import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const sessionId = process.env.ANTNEST_E2E_SESSION_ID;
assert(agentId && sessionId);

const member = new GatewayClient("http://edge-gateway:8080");
const login = (
  await member.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "c4-member@example.com",
      password: "c4-member-password",
    },
  })
).body;
const principal = login.principal;
assert(principal?.organization_id && principal?.user_id);
const policyUrl = `http://agent-controller:8080/internal/agents/${agentId}/skill-learning-policy`;
const query = new URLSearchParams({
  organization_id: principal.organization_id,
  principal_id: principal.user_id,
});
const beforeResponse = await fetch(`${policyUrl}?${query}`);
assert.equal(beforeResponse.status, 200);
const before = await beforeResponse.json();
assert.equal(before.mode, "automatic");
const pinnedPath = ".antnest/skills/fixture-procedure";
const changed = await fetch(policyUrl, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    request_id: "pin-learned-fixture-skill",
    organization_id: principal.organization_id,
    actor_principal_id: principal.user_id,
    expected_revision: before.revision,
    mode: before.mode,
    scope: before.scope,
    pinned_paths: [pinnedPath],
    limits: before.limits,
  }),
});
assert.equal(changed.status, 200, await changed.clone().text());
const policy = await changed.json();
assert.deepEqual(policy.pinned_paths, [pinnedPath]);
assert.notEqual(policy.revision, before.revision);

const client = connectACP(1, agentId, member.cookie, {
  clientCapabilities: { session: { notices: {} } },
});
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
        {
          type: "text",
          text: "learn: For the fixture task, check the result after editing it.",
        },
      ],
    },
    90_000,
  );
  assert.equal(reply.stopReason, "end_turn");
  console.log(
    JSON.stringify({
      status: "pinned_update_run_completed",
      policy_revision: policy.revision,
    }),
  );
} finally {
  client.close();
}
