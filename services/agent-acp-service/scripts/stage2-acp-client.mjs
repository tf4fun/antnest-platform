import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import WebSocket from "ws";

const acpUrl = required("ANTNEST_STAGE2_ACP_URL");
const accessSubject = required("ANTNEST_STAGE2_AGENT_ACCESS_SUBJECT");
const traceparent = required("ANTNEST_STAGE2_TRACEPARENT");
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
  process.stdout.write(
    `${JSON.stringify({ session_id: created.sessionId, update_kinds: updateKinds, message: text })}\n`,
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
