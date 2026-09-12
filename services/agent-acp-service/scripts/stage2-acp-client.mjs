import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import WebSocket from "ws";
import { assertPromptEvidence } from "./stage2-acp-evidence.mjs";

const acpUrl = required("ANTNEST_STAGE2_ACP_URL");
const accessSubject = required("ANTNEST_STAGE2_AGENT_ACCESS_SUBJECT");
const traceparent = required("ANTNEST_STAGE2_TRACEPARENT");
const identityUrl = new URL(required("ANTNEST_STAGE2_IDENTITY_URL"));
const organizationId = required("ANTNEST_STAGE2_ORGANIZATION_ID");
const actorPrincipalId = required("ANTNEST_STAGE2_ACTOR_PRINCIPAL_ID");
const ownerMembershipId = required("ANTNEST_STAGE2_OWNER_MEMBERSHIP_ID");
const updates = [];
const idle = Promise.withResolvers();
const closed = new AbortController();

const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
  updates.push(params);
  if (params.update.sessionUpdate === "state_update" && params.update.state === "idle") {
    idle.resolve(params.update);
  }
});
class OwnedSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    this.on("error", (error) => closed.abort(error));
  }
}
const connection = client.connect(
  createWebSocketStream(acpUrl, {
    WebSocket: OwnedSocket,
    headers: {
      "x-antnest-agent-access-subject": accessSubject,
      traceparent,
    },
  }),
);
connection.closed.then(
  () => closed.abort(new Error("ACP connection closed")),
  (error) => closed.abort(error),
);

async function bounded(work) {
  const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(30000)]);
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      reject(signal.reason);
      connection.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
const request = (method, params) =>
  bounded((signal) => connection.agent.request(method, params, { cancellationSignal: signal }));

try {
  await request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    info: { name: "antnest-stage2-e2e", version: "1.0.0" },
    capabilities: {},
  });
  await bounded(() => connection.initialized);
  const created = await request(acp.methods.agent.session.new, {
    cwd: "/workspace",
    mcpServers: [],
  });
  const promptStart = updates.length;
  const acknowledged = await request(acp.methods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "Create the Stage 2 acceptance evidence file." }],
    _meta: { traceparent },
  });
  await bounded(() => idle.promise);
  const text = assertPromptEvidence(acknowledged, updates.slice(promptStart), created.sessionId);
  const updateKinds = updates.map(({ update }) => update.sessionUpdate);
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

async function deactivateOwnerMembership() {
  const response = await fetch(new URL("/rpc/identity/update-membership", identityUrl), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      request_id: "stage2-owner-deactivate",
      actor_principal_id: actorPrincipalId,
      organization_id: organizationId,
      membership_id: ownerMembershipId,
      email: "stage2-owner@example.com",
      display_name: "Stage 2 Owner",
      role: "member",
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
    await request(acp.methods.agent.session.prompt, {
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
