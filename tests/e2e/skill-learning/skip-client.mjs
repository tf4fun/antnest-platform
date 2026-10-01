import assert from "node:assert/strict";
import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const reviewFailure = process.env.ANTNEST_E2E_REVIEW_FAILURE === "true";
const reviewUntrusted = process.env.ANTNEST_E2E_REVIEW_UNTRUSTED === "true";
assert(agentId);
const member = new GatewayClient("http://edge-gateway:8080");
await member.request("/api/session/login", {
  body: {
    organization_slug: "stage3",
    email: "c4-member@example.com",
    password: "c4-member-password",
  },
});
const client = connectACP(1, agentId, member.cookie, {
  clientCapabilities: { session: { notices: {} } },
});
try {
  await client.initialize();
  const { sessionId } = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  const result = await client.request(
    "prompt",
    {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "learn: For the fixture task, inspect the target before editing it.",
        },
      ],
    },
    90_000,
  );
  assert.equal(result.stopReason, "end_turn");
  const model = await until(
    async () => {
      const status = await fetch("http://stage3-model:8080/status").then(
        (response) => response.json(),
      );
      return (
        status.requests.includes(
          reviewFailure
            ? "review-failure"
            : reviewUntrusted
              ? "review-untrusted-repair"
              : "review-skip",
        ) && status
      );
    },
    reviewFailure
      ? "background review model failure"
      : reviewUntrusted
        ? "second untrusted-only review proposal"
        : "background review skip",
    undefined,
    60_000,
  );
  assert.deepEqual(model.errors, []);
  console.log(
    JSON.stringify({
      status: reviewFailure
        ? "review_model_failure_requested"
        : reviewUntrusted
          ? "review_untrusted_only_requested"
          : "review_skip_requested",
      agent_id: agentId,
      session_id: sessionId,
    }),
  );
} finally {
  client.close();
}
