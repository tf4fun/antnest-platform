import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { serviceClient } from "../../support/service-grants.mjs";
import { assertAdmissionError } from "../../support/acp-errors.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { openSkillACP, withSkillACPClient } from "./private-client.mjs";
import { member } from "../workspace-closeout/c4-setup.mjs";

const mode = process.env.ANTNEST_E2E_OWNER_RECOVERY;
const agentId = process.env.ANTNEST_E2E_AGENT_ID;
assert(agentId);
assert(["manual", "auto", "denied", "prompt"].includes(mode));
if (mode === "manual" || mode === "auto") {
  const services = serviceClient();
  const { context, principal } = await services.callerContext({
    organization_slug: "stage3",
    email: "stage3-admin@example.com",
    password: "stage3-admin-password",
  });
  const endpoint =
    "http://agent-controller:8080/internal/runtime-barrier-recovery-policy";
  const previous = await services.json(
    `${endpoint}?organization_id=${encodeURIComponent(principal.organization_id)}`,
    "console-controller",
    { method: "GET", context },
  );
  const policy = await services.json(endpoint, "console-controller", {
    method: "PUT",
    context,
    body: {
      request_id: randomUUID(),
      organization_id: principal.organization_id,
      actor_principal_id: principal.user_id,
      expected_revision: previous.revision,
      mode,
      cooldown_ms: 60000,
    },
  });
  assert.deepEqual(policy, {
    organization_id: principal.organization_id,
    revision: previous.revision + 1,
    mode,
    cooldown_ms: 60000,
  });
  console.log(JSON.stringify({ status: "recovery_policy_applied", policy }));
} else {
  const browser = new GatewayClient("http://edge-gateway:8080");
  const login = await browser.request("/api/session/login", { body: member });
  const client = await openSkillACP(1, agentId, browser, {
    principal: login.body.principal,
  });
  await withSkillACPClient(client, async () => {
    if (mode === "denied") {
      const sessionId = process.env.ANTNEST_E2E_SOURCE_SESSION_ID;
      assert(sessionId);
      await assert.rejects(
        client.request("prompt", {
          sessionId,
          prompt: [
            {
              type: "text",
              text: "must not dispatch during owner Runtime protection",
            },
          ],
        }),
        (error) => {
          assertAdmissionError(error, "agent_unavailable");
          return true;
        },
      );
      console.log(
        JSON.stringify({
          status: "protected_prompt_denied",
          session_id: sessionId,
        }),
      );
    } else {
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
        90000,
      );
      assert.equal(reply.stopReason, "end_turn");
      console.log(
        JSON.stringify({
          status: "replacement_prompt_completed",
          session_id: sessionId,
        }),
      );
    }
  });
}
