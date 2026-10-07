import assert from "node:assert/strict";

import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { serviceCalls } from "./service-calls.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const sessionId = process.env.ANTNEST_E2E_SESSION_ID;
assert(agentId && sessionId);

const member = new GatewayClient("http://edge-gateway:8080");
const account = {
  organization_slug: "stage3",
  email: "c4-member@example.com",
  password: "c4-member-password",
};
const login = (await member.request("/api/session/login", { body: account }))
  .body;
const principal = login.principal;
assert(principal?.organization_id && principal?.user_id);
const services = serviceCalls();
const before = await services.learningPolicy(agentId, {
  organization_id: principal.organization_id,
  principal_id: principal.user_id,
});
assert.equal(before.mode, "automatic");
const pinnedPath = ".antnest/skills/fixture-procedure";
const policy = await services.setLearningPolicy(agentId, account, {
  request_id: "pin-learned-fixture-skill",
  organization_id: principal.organization_id,
  actor_principal_id: principal.user_id,
  expected_revision: before.revision,
  mode: before.mode,
  scope: before.scope,
  pinned_paths: [pinnedPath],
  limits: before.limits,
});
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
