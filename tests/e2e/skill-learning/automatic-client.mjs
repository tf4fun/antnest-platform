import assert from "node:assert/strict";
import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const mode = process.env.ANTNEST_E2E_LEARNING_MODE;
const uiOffline = process.env.ANTNEST_E2E_UI_OFFLINE === "true";
const noticeFailure = process.env.ANTNEST_E2E_NOTICE_SEND_FAILURE === "true";
const debug = process.env.ANTNEST_E2E_SKILL_LEARNING_DEBUG === "true";
const peer = process.env.ANTNEST_E2E_SKILL_CALLER_PEER === "true";
assert(agentId);
assert(["create", "update", "verify"].includes(mode));
assert(!peer || mode === "create");
const gateway = "http://edge-gateway:8080";
const member = new GatewayClient(gateway);
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
const setup = { cwd: "/workspace", mcpServers: [] };
let sessionId;
try {
  await client.initialize();
  if (mode === "create") {
    ({ sessionId } =
      debug || peer
        ? await until(
            async () => {
              try {
                return await client.request("new", setup);
              } catch (error) {
                if (error?.data?.code === "configuration_not_ready")
                  return null;
                throw error;
              }
            },
            "Controller configuration ready before learning",
            undefined,
            90_000,
          )
        : await client.request("new", setup));
  } else {
    sessionId = process.env.ANTNEST_E2E_SESSION_ID;
    assert(sessionId);
    if (debug || process.env.ANTNEST_E2E_SKILL_KEY_ROTATION === "true") {
      await until(
        async () => {
          try {
            return await client.request("load", { ...setup, sessionId });
          } catch (error) {
            if (error?.data?.code === "configuration_not_ready") return null;
            throw error;
          }
        },
        "Controller configuration republished after ACP signer switch",
        undefined,
        90_000,
      );
    } else {
      await client.request("load", { ...setup, sessionId });
    }
  }
  const run = async (text) => {
    const result = await client.request(
      "prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      90_000,
    );
    assert.equal(result.stopReason, "end_turn");
  };
  const notices = async () => {
    const view = (
      await member.request(
        `/api/app/workspace/v1/agents/${agentId}/view?sessionId=${sessionId}`,
      )
    ).body;
    return view.systemNotices ?? [];
  };
  const liveNotice = async (kind) =>
    until(
      () =>
        client.updates.find(
          (entry) =>
            entry.update?.sessionUpdate === "notice" &&
            entry.update?._meta?.["antnest.dev/skill-learning"]?.kind === kind,
        ),
      `live SDK ${kind} notice`,
      undefined,
      30_000,
    );
  if (mode === "verify") {
    assert(
      client.updates.some(
        (entry) =>
          entry.update?.sessionUpdate === "available_commands_update" &&
          entry.update.availableCommands.some(
            (command) => command.name === "skill:personal:fixture-procedure",
          ),
      ),
    );
    await run(
      "/skill:personal:fixture-procedure verify selected skill command",
    );
    await run("verify learned procedure");
    const model = await fetch(
      `${process.env.ANTNEST_E2E_MODEL_URL}/status`,
    ).then((response) => response.json());
    assert.deepEqual(model.errors, []);
    assert(model.requests.includes("foreground-verify-tool"));
    assert(model.requests.includes("foreground-verify-reply"));
    assert(model.requests.includes("foreground-skill-command-reply"));
    assert.equal((await notices()).length, 2);
    console.log(
      JSON.stringify({
        status: "debug_learned_skill_read",
        session_id: sessionId,
      }),
    );
  } else if (mode === "create") {
    await run(
      `learn: ${peer ? "peer source: " : ""}For the fixture task, inspect the target before editing it.`,
    );
    const created = await until(
      async () =>
        (await notices()).find((notice) => notice.kind === "skill_created"),
      "automatic Skill creation notice",
      undefined,
      60_000,
    );
    assert.equal(created.sourceSessionId, sessionId);
    assert(created.sourceRunId);
    assert.equal(created.agentId, agentId);
    assert.equal(created.skillName, "fixture-procedure");
    assert.equal(created.changeSummary, "已新增 Skill「fixture-procedure」");
    assert.match(created.occurredAt, /^\d{4}-\d{2}-\d{2}T/u);
    if (noticeFailure) {
      await until(
        () => client.closeCode !== undefined,
        "failed notice closes the original ACP connection",
        undefined,
        30_000,
      );
      assert.equal(
        client.updates.some(
          (entry) =>
            entry.update?._meta?.["antnest.dev/skill-learning"]?.changeId ===
            created.changeId,
        ),
        false,
      );
    } else {
      const live = await liveNotice("skill_created");
      assert.equal(
        live.update._meta["antnest.dev/skill-learning"].changeId,
        created.changeId,
      );
    }
    console.log(
      JSON.stringify({
        status: "skill_created",
        agent_id: agentId,
        session_id: sessionId,
        created_change_id: created.changeId,
      }),
    );
  } else {
    const createdChangeId = process.env.ANTNEST_E2E_CREATED_CHANGE_ID;
    assert(createdChangeId);
    if (!uiOffline)
      await until(
        async () =>
          (await notices()).find(
            (notice) => notice.changeId === createdChangeId,
          ),
        "created Skill notice restored",
        undefined,
        30_000,
      );
    await run(
      "learn: For the fixture task, check the result after editing it.",
    );
    const live = await liveNotice("skill_updated");
    const liveChangeId =
      live.update._meta["antnest.dev/skill-learning"].changeId;
    assert.notEqual(liveChangeId, createdChangeId);
    let updated;
    if (!uiOffline) {
      updated = await until(
        async () =>
          (await notices()).find((notice) => notice.kind === "skill_updated"),
        "automatic Skill update notice",
        undefined,
        60_000,
      );
      assert.equal(updated.changeId, liveChangeId);
      assert.equal(updated.sourceSessionId, sessionId);
      assert.equal(updated.agentId, agentId);
      assert.equal(updated.skillName, "fixture-procedure");
      assert.equal(updated.changeSummary, "已更新 Skill「fixture-procedure」");
      assert.match(updated.occurredAt, /^\d{4}-\d{2}-\d{2}T/u);
    }
    if (!debug) await run("verify learned procedure");
    const model = await fetch(
      `${process.env.ANTNEST_E2E_MODEL_URL}/status`,
    ).then((response) => response.json());
    assert.deepEqual(model.errors, []);
    for (const kind of debug
      ? [
          "foreground-create-tool-1",
          "foreground-create-reply",
          "review-debug-create-skip",
          "review-create",
          "foreground-update-tool-1",
          "foreground-update-reply",
          "review-debug-update-skip",
          "review-update",
        ]
      : [
          "foreground-create-tool-1",
          "foreground-create-tool-2",
          "foreground-create-tool-3",
          "foreground-create-reply",
          "review-create",
          "foreground-update-tool-1",
          "foreground-update-tool-2",
          "foreground-update-tool-3",
          "foreground-update-reply",
          "review-update",
          "foreground-verify-tool",
          "foreground-verify-reply",
        ])
      assert(model.requests.includes(kind), `missing model phase: ${kind}`);
    if (!uiOffline) {
      client.close();
      const reconnected = connectACP(1, agentId, member.cookie, {
        clientCapabilities: { session: { notices: {} } },
      });
      try {
        await reconnected.initialize();
        await reconnected.request("load", { ...setup, sessionId });
        const restored = await until(
          async () => {
            const items = await notices();
            return items.some((item) => item.changeId === createdChangeId) &&
              items.some((item) => item.changeId === liveChangeId)
              ? items
              : null;
          },
          "learning changes restored after ACP client reconnect",
          undefined,
          30_000,
        );
        assert.equal(restored.length, 2);
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        assert.deepEqual(
          reconnected.updates.filter(
            (entry) =>
              entry.update?.sessionUpdate === "notice" &&
              entry.update?._meta?.["antnest.dev/skill-learning"],
          ),
          [],
          "a new ACP connection must not replay historical learning notices",
        );
      } finally {
        reconnected.close();
      }
    }
    console.log(
      JSON.stringify({
        status: uiOffline
          ? "automatic_learning_during_ui_outage"
          : "automatic_learning_passed",
        agent_id: agentId,
        session_id: sessionId,
        created_change_id: createdChangeId,
        updated_change_id: liveChangeId,
        model_requests: model.requests,
      }),
    );
  }
} finally {
  client.close();
}
