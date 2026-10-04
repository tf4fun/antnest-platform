import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";
import { temporarySkillArchive } from "../../support/temporary-skill-fixture.mjs";
const mode = process.env.ANTNEST_E2E_TEMPORARY_MODE,
  agentId = process.env.ANTNEST_E2E_AGENT_ID;
assert(agentId && ["use", "cancel", "restart", "retry"].includes(mode));
const memberClient = new GatewayClient("http://edge-gateway:8080");
const cookie = process.env.ANTNEST_E2E_MEMBER_COOKIE;
if (cookie) {
  for (const pair of cookie.split("; ")) {
    const index = pair.indexOf("=");
    assert(index > 0);
    memberClient.cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
} else await memberClient.request("/api/session/login", { body: member });
if (mode === "use") {
  const admin = new GatewayClient(memberClient.base);
  await admin.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  const form = new FormData();
  form.set(
    "artifact",
    new Blob([temporarySkillArchive()], { type: "application/zip" }),
    "temporary-procedure.zip",
  );
  const reply = await fetch(`${admin.base}/api/admin/skills`, {
    method: "POST",
    headers: {
      Cookie: admin.cookie,
      Origin: admin.base,
      "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
      "Idempotency-Key": randomUUID(),
    },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(reply.status, 201);
  assert.equal((await reply.json()).name, "temporary-procedure");
}
const acp = connectACP(1, agentId, memberClient.cookie, {
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
    "temporary target configuration",
    undefined,
    90000,
  );
  const pending = acp.request(
    "prompt",
    {
      sessionId,
      prompt: [
        {
          type: "text",
          text:
            mode === "retry"
              ? "temporary clean admission"
              : `temporary package ${mode}`,
        },
      ],
    },
    120000,
  );
  if (mode === "restart") {
    let interrupted = false;
    try {
      await pending;
    } catch {
      interrupted = true;
    }
    assert(interrupted, "normal ACP restart must interrupt the held request");
    console.log(
      JSON.stringify({ mode, session_id: sessionId, status: "interrupted" }),
    );
  } else {
    if (mode === "cancel") {
      await until(async () => {
        const status = await fetch(
          `${process.env.ANTNEST_E2E_MODEL_URL}/status`,
        ).then((reply) => reply.json());
        return status.pending.includes("temporary-cancel-reply");
      }, "held temporary cancellation request");
      await acp.notify("cancel", { sessionId });
    }
    const reply = await pending;
    assert.equal(
      reply.stopReason,
      mode === "cancel" ? "cancelled" : "end_turn",
    );
    const tools = acp.updates
      .filter((entry) => entry.update.sessionUpdate === "tool_call")
      .map((entry) => entry.update.title);
    if (mode !== "retry") assert.equal(tools.length, 4);
    console.log(
      JSON.stringify({
        mode,
        session_id: sessionId,
        status: reply.stopReason,
        tools,
        trace_id: acp.traceID,
      }),
    );
  }
} finally {
  await acp.close();
}
