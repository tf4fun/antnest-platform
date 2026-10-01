import assert from "node:assert/strict";

import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const sessionId = process.env.ANTNEST_E2E_SESSION_ID;
const failedSourceRunId = process.env.ANTNEST_E2E_FAILED_SOURCE_RUN_ID;
assert(agentId && sessionId && failedSourceRunId);

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
  await client.request("load", {
    cwd: "/workspace",
    mcpServers: [],
    sessionId,
  });
  const view = async (diagnostic = false) =>
    (
      await member.request(
        `/api/app/workspace/v1/agents/${agentId}/view?sessionId=${sessionId}${diagnostic ? "&learningStatus=1" : ""}`,
      )
    ).body;
  if (process.env.ANTNEST_E2E_DIAGNOSTIC_ALREADY_READ !== "true")
    assert.equal(
      (await view()).learningStatus ?? null,
      null,
      "ordinary View has not requested a background diagnostic",
    );
  const beforeStatus = (await view(true)).learningStatus;
  assert.deepEqual(beforeStatus, {
    agentId,
    blocked: {
      reason: "runtime_unavailable",
      sourceSessionId: sessionId,
      sourceRunId: failedSourceRunId,
    },
  });
  const run = async (text) => {
    const result = await client.request(
      "prompt",
      {
        sessionId,
        prompt: [{ type: "text", text }],
      },
      90_000,
    );
    assert.equal(result.stopReason, "end_turn");
  };

  // The unresolved review's model cost must not occupy the foreground Runtime.
  await run("foreground during review");
  const recovery = await fetch("http://stage3-model:8080/recover-review", {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(recovery.status, 200);
  assert.deepEqual(await recovery.json(), { recovered: true });

  await run(
    "learn: after model recovery: For the fixture task, inspect the target before editing it.",
  );
  const created = await until(
    async () => {
      const notices = (await view()).systemNotices ?? [];
      assert(
        notices.length <= 1,
        "the failed source must not produce a second change",
      );
      return notices.find((notice) => notice.kind === "skill_created");
    },
    "new source creates a Skill after the review provider recovers",
    undefined,
    60_000,
  );
  assert.equal(created.agentId, agentId);
  assert.equal(created.sourceSessionId, sessionId);
  assert.equal(created.skillName, "fixture-procedure");
  assert.notEqual(created.sourceRunId, failedSourceRunId);
  assert(created.sourceRunId);
  const live = await until(
    () =>
      client.updates.find(
        (entry) =>
          entry.update?.sessionUpdate === "notice" &&
          entry.update?._meta?.["antnest.dev/skill-learning"]?.changeId ===
            created.changeId,
      ),
    "recovered learning sends its live SDK notice",
    undefined,
    30_000,
  );
  assert.equal(
    live.update._meta["antnest.dev/skill-learning"].kind,
    "skill_created",
  );

  await run("verify learned procedure after model recovery");
  const model = await fetch("http://stage3-model:8080/status", {
    signal: AbortSignal.timeout(5_000),
  }).then((response) => response.json());
  assert.deepEqual(model.errors, []);
  assert.equal(
    model.requests.filter((kind) => kind === "review-failure").length,
    1,
  );
  assert.equal(
    model.requests.filter((kind) => kind === "review-recovered-create").length,
    1,
  );
  assert.equal(
    model.requests.includes("review-create"),
    false,
    "the failed source was not replayed",
  );
  for (const kind of [
    "foreground-preempt-reply",
    "foreground-recovered-create-tool-1",
    "foreground-recovered-create-tool-2",
    "foreground-recovered-create-tool-3",
    "foreground-recovered-create-reply",
    "foreground-recovery-verify-tool",
    "foreground-recovery-verify-reply",
  ])
    assert(model.requests.includes(kind), `missing model phase: ${kind}`);
  assert.deepEqual(
    (await view(true)).learningStatus,
    beforeStatus,
    "the diagnostic describes the retained old review, not current provider health",
  );

  console.log(
    JSON.stringify({
      status: "learning_after_model_recovery",
      session_id: sessionId,
      source_run_id: created.sourceRunId,
      change_id: created.changeId,
      model_requests: model.requests,
      learning_status: beforeStatus,
    }),
  );
} finally {
  client.close();
}
