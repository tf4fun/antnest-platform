import assert from "node:assert/strict";
import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const stopAfterPending = process.env.ANTNEST_E2E_STOP_AFTER_PENDING === "true";
const lifecycleDisable = process.env.ANTNEST_E2E_LIFECYCLE_DISABLE === "true";
const lifecycleRebuild = process.env.ANTNEST_E2E_LIFECYCLE_REBUILD === "true";
const heldCommit = process.env.ANTNEST_E2E_HELD_COMMIT_DISABLE === "true";
const policyOff = process.env.ANTNEST_E2E_POLICY_OFF === "true";
assert(agentId);
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
const client = connectACP(1, agentId, member.cookie);
const status = () =>
  fetch("http://stage3-model:8080/status").then((response) => response.json());
try {
  await client.initialize();
  const { sessionId } = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  const initial = await client.request(
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
  assert.equal(initial.stopReason, "end_turn");
  await until(
    async () => (await status()).pending.includes("review-create"),
    "background review model request",
    undefined,
    60_000,
  );
  if (policyOff) {
    const principal = login.principal;
    assert(principal?.organization_id && principal?.user_id);
    const url = `http://agent-controller:8080/internal/agents/${agentId}/skill-learning-policy`;
    const query = new URLSearchParams({
      organization_id: principal.organization_id,
      principal_id: principal.user_id,
    });
    const before = await fetch(`${url}?${query}`).then((response) =>
      response.json(),
    );
    assert.equal(before.mode, "automatic");
    const changed = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "learning-policy-off-during-review",
        organization_id: principal.organization_id,
        actor_principal_id: principal.user_id,
        expected_revision: before.revision,
        mode: "off",
        scope: before.scope,
        pinned_paths: before.pinned_paths,
        limits: before.limits,
      }),
    });
    assert.equal(
      changed.status,
      200,
      changed.status === 200 ? undefined : await changed.text(),
    );
    assert.equal((await changed.json()).mode, "off");
    const stopped = await until(
      async () => {
        const current = await status();
        return current.cancelled.includes("review-create") ? current : null;
      },
      "review model request cancelled after policy off",
      undefined,
      15_000,
    );
    assert.deepEqual(stopped.pending, []);
    console.log(
      JSON.stringify({
        status: "policy_off_during_review",
        agent_id: agentId,
        session_id: sessionId,
      }),
    );
  } else if (stopAfterPending) {
    console.log(
      JSON.stringify({
        status: lifecycleDisable
          ? "review_pending_for_disable"
          : lifecycleRebuild
            ? "review_pending_for_rebuild"
            : heldCommit
              ? "review_pending_for_commit"
              : "review_pending_for_restart",
        agent_id: agentId,
        session_id: sessionId,
      }),
    );
  } else {
    const foreground = await client.request(
      "prompt",
      {
        sessionId,
        prompt: [{ type: "text", text: "foreground during review" }],
      },
      30_000,
    );
    assert.equal(foreground.stopReason, "end_turn");
    const model = await until(
      async () => {
        const current = await status();
        return current.cancelled.includes("review-create") && current;
      },
      "review model request cancelled",
      undefined,
      10_000,
    );
    assert.deepEqual(model.pending, []);
    assert.deepEqual(model.errors, []);
    assert(model.requests.includes("foreground-preempt-reply"));
    const view = (
      await member.request(
        `/api/app/workspace/v1/agents/${agentId}/view?sessionId=${sessionId}`,
      )
    ).body;
    assert.deepEqual(view.systemNotices ?? [], []);
    console.log(
      JSON.stringify({
        status: "foreground_preempted_review",
        agent_id: agentId,
        session_id: sessionId,
        model_requests: model.requests,
        cancelled: model.cancelled,
      }),
    );
  }
} finally {
  client.close();
}
