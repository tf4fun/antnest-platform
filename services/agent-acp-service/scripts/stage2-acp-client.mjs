import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import WebSocket from "ws";

const acpUrl = required("ANTNEST_STAGE2_ACP_URL");
const accessSubject = required("ANTNEST_STAGE2_AGENT_ACCESS_SUBJECT");
const traceparent = required("ANTNEST_STAGE2_TRACEPARENT");
const identityUrl = new URL(required("ANTNEST_STAGE2_IDENTITY_URL"));
const organizationId = required("ANTNEST_STAGE2_ORGANIZATION_ID");
const ownerUserId = required("ANTNEST_STAGE2_OWNER_USER_ID");
const ownerMembershipId = required("ANTNEST_STAGE2_OWNER_MEMBERSHIP_ID");
const updates = [];
const idle = Promise.withResolvers();

const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
  updates.push(params.update);
  if (params.update.sessionUpdate === "state_update" && params.update.state === "idle") {
    idle.resolve(params.update);
  }
});
const connection = client.connect(
  createWebSocketStream(acpUrl, {
    WebSocket,
    headers: {
      "x-antnest-agent-access-subject": accessSubject,
      traceparent,
    },
  }),
);

try {
  await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    info: { name: "antnest-stage2-e2e", version: "1.0.0" },
    capabilities: {},
  });
  await connection.initialized;
  const created = await connection.agent.request(acp.methods.agent.session.new, {
    cwd: "/workspace",
    mcpServers: [],
  });
  await connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "Create the Stage 2 acceptance evidence file." }],
    _meta: { traceparent },
  });
  await Promise.race([
    idle.promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("ACP Run did not become idle")), 30_000).unref();
    }),
  ]);

  const updateKinds = updates.map((update) => update.sessionUpdate);
  requireUpdate(updateKinds, "tool_call_update");
  requireUpdate(updateKinds, "agent_message");
  requireUpdate(updateKinds, "state_update");
  const message = updates.findLast((update) => update.sessionUpdate === "agent_message");
  const text = message?.content?.find((block) => block.type === "text")?.text;
  if (text !== "Stage 2 Runtime Tool execution completed.") {
    throw new Error(`unexpected final Agent message: ${String(text)}`);
  }
  await deactivateOwnerMembership();
  const accessRevalidationCode = await expectPromptAccessDenied(created.sessionId);
  process.stdout.write(
    `${JSON.stringify({
      session_id: created.sessionId,
      update_kinds: updateKinds,
      message: text,
      access_revalidation_code: accessRevalidationCode,
    })}\n`,
  );
} finally {
  connection.close();
  await connection.closed;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireUpdate(kinds, expected) {
  if (!kinds.includes(expected)) {
    throw new Error(`ACP updates did not include ${expected}: ${kinds.join(",")}`);
  }
}

async function deactivateOwnerMembership() {
  const response = await fetch(new URL("/rpc/identity/update-membership", identityUrl), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      request_id: "stage2-owner-deactivate",
      actor_principal_id: ownerUserId,
      organization_id: organizationId,
      membership_id: ownerMembershipId,
      email: "stage2-admin@example.com",
      display_name: "Stage 2 Administrator",
      role: "admin",
      active: false,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.membership?.active !== false) {
    throw new Error(`could not deactivate Stage 2 owner membership: ${JSON.stringify(payload)}`);
  }
}

async function expectPromptAccessDenied(sessionId) {
  try {
    await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "This prompt must not be admitted." }],
      _meta: { traceparent },
    });
  } catch (error) {
    if (error?.data?.code === "access_denied" && error.data.retryable === false) {
      return error.data.code;
    }
    throw error;
  }
  throw new Error("inactive owner prompt was admitted on an existing ACP connection");
}
