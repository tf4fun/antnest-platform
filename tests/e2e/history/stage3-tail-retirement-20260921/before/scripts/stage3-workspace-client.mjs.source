import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { WebSocket } from "ws";

const gateway = required("ANTNEST_STAGE3_GATEWAY_WS");
const origin = required("ANTNEST_STAGE3_GATEWAY_ORIGIN");
const cookie = required("ANTNEST_STAGE3_COOKIE");
const results = [];
for (const transport of ["websocket", "http"]) {
  results.push(await exercise(transport));
}
process.stdout.write(JSON.stringify({ status: "passed", transports: results }));

async function exercise(transport) {
  const updates = [];
  const application = acp
    .client({ name: "antnest-stage3-workspace-e2e" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(structuredClone(params));
    })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }));

  const open = () =>
    application.connect(
      transport === "websocket"
        ? createWebSocketStream(gateway, {
            WebSocket,
            headers: { Cookie: cookie, Origin: origin },
          })
        : createHttpStream(gateway.replace(/^ws/, "http"), {
            headers: {
              Cookie: cookie,
              Origin: origin,
              "X-Antnest-CSRF-Token": csrfCookie(),
            },
          }),
    );
  let connection = open();

  try {
    const options = { signal: AbortSignal.timeout(120_000) };
    const initialized = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "antnest-stage3-workspace-e2e", version: "0.1.0" },
      },
      options,
    );
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`unexpected ACP version ${initialized.protocolVersion}`);
    }
    if (
      initialized.agentCapabilities?.sessionCapabilities?.list === undefined
    ) {
      throw new Error("Agent did not advertise session/list");
    }

    await connection.agent.request(acp.methods.agent.session.list, {}, options);
    const created = await connection.agent.request(
      acp.methods.agent.session.new,
      {
        cwd: "/workspace",
        mcpServers: [],
      },
      options,
    );
    const result = await connection.agent.request(
      acp.methods.agent.session.prompt,
      {
        sessionId: created.sessionId,
        prompt: [
          { type: "text", text: "Create the Stage 3 workspace evidence file." },
        ],
      },
      options,
    );
    if (result.stopReason !== "end_turn") {
      throw new Error(`unexpected stop reason ${result.stopReason}`);
    }
    assertLiveUpdates(updates, created.sessionId);

    connection.close();
    await connection.closed;
    connection = open();
    await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      },
      options,
    );
    updates.length = 0;
    await connection.agent.request(
      acp.methods.agent.session.load,
      {
        sessionId: created.sessionId,
        cwd: "/workspace",
        mcpServers: [],
      },
      options,
    );
    assertReplayUpdates(updates, created.sessionId);

    return {
      transport,
      session_id: created.sessionId,
      replayed_updates: updates.length,
      status: "passed",
    };
  } finally {
    connection.close();
    await connection.closed;
  }
}

function csrfCookie() {
  const prefix = "antnest_csrf=";
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error("Workspace CSRF cookie is missing");
  return value;
}

function assertLiveUpdates(received, sessionID) {
  const sessionUpdates = received
    .filter((item) => item.sessionId === sessionID)
    .map((item) => item.update);
  if (
    !sessionUpdates.some(
      (update) => update.sessionUpdate === "agent_message_chunk",
    )
  ) {
    throw new Error("ACP Agent message update is missing");
  }
  if (
    !sessionUpdates.some(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        update.status === "completed",
    )
  ) {
    throw new Error("ACP completed Tool update is missing");
  }
}

function assertReplayUpdates(received, sessionID) {
  const sessionUpdates = received
    .filter((item) => item.sessionId === sessionID)
    .map((item) => item.update);
  if (
    !sessionUpdates.some(
      (update) => update.sessionUpdate === "user_message_chunk",
    )
  ) {
    throw new Error("ACP replayed user message is missing");
  }
  assertLiveUpdates(received, sessionID);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
