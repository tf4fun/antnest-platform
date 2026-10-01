import assert from "node:assert/strict";
import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const sourceAgentId = process.env.ANTNEST_E2E_SOURCE_AGENT_ID;
assert(agentId && sourceAgentId && agentId !== sourceAgentId);
const client = new GatewayClient("http://edge-gateway:8080");
const login = (await client.request("/api/session/login", { body: member }))
  .body;
if (process.env.ANTNEST_E2E_SKILL_TEMPORARY === "true") {
  const policyUrl = `http://agent-controller:8080/internal/agents/${agentId}/skill-learning-policy`;
  const query = new URLSearchParams({
    organization_id: login.principal.organization_id,
    principal_id: login.principal.user_id,
  });
  const before = await fetch(`${policyUrl}?${query}`).then((reply) => {
    assert.equal(reply.status, 200);
    return reply.json();
  });
  const changed = await fetch(policyUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: "temporary-fixture-policy-off",
      organization_id: login.principal.organization_id,
      actor_principal_id: login.principal.user_id,
      expected_revision: before.revision,
      mode: "off",
      scope: before.scope,
      pinned_paths: before.pinned_paths,
      limits: before.limits,
    }),
  });
  assert.equal(changed.status, 200);
}
const acp = connectACP(1, agentId, client.cookie, {
  requestPermission: ({ params }) => ({
    outcome: {
      outcome: "selected",
      optionId: params.options.find((option) => option.kind === "allow_once")
        .optionId,
    },
  }),
});
try {
  await acp.initialize();
  const { sessionId } = await until(
    async () => {
      try {
        return await acp.request("new", { cwd: "/workspace", mcpServers: [] });
      } catch (error) {
        if (error?.data?.code === "configuration_not_ready") return null;
        throw error;
      }
    },
    "target Agent configuration",
    undefined,
    90000,
  );
  assert.equal(
    (
      await acp.request(
        "prompt",
        {
          sessionId,
          prompt: [
            { type: "text", text: "discover reusable fixture-procedure" },
          ],
        },
        90000,
      )
    ).stopReason,
    "end_turn",
  );
  const starts = acp.updates.filter(
    (entry) => entry.update.sessionUpdate === "tool_call",
  );
  assert.deepEqual(
    starts.map((entry) => entry.update.title),
    ["Find Skill", "Load Skill"],
  );
  const view = (
    await client.request(
      `/api/app/workspace/v1/agents/${agentId}/view?sessionId=${sessionId}`,
    )
  ).body;
  assert.equal(view.systemNotices?.length ?? 0, 0);
  console.log(
    JSON.stringify({
      status: "model_discovery_guidance_loaded",
      source_agent_id: sourceAgentId,
      target_agent_id: agentId,
      session_id: sessionId,
      tools: starts.map((entry) => entry.update.title),
    }),
  );
} finally {
  await acp.close();
}
