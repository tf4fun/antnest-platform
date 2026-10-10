import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import * as acp from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { createHttpStream } from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/http-stream.js";
import { createParser } from "../../../services/agent-acp-service/node_modules/eventsource-parser/dist/index.js";

export async function firstGatewayState(origin, login, agentId) {
  const response = await fetch(
    `${origin}/api/app/agents/${agentId}/state/watch`,
    {
      headers: { cookie: login.cookie, origin: gatewayOrigin(origin) },
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/u,
  );
  let state;
  const parser = createParser({
    onEvent(event) {
      assert.equal(event.event, "workspace_state");
      state = JSON.parse(event.data);
      assert.equal(state.agent_id, agentId);
    },
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (state === undefined) {
      const { value, done } = await reader.read();
      assert(!done, "state stream ended without a snapshot");
      parser.feed(value);
    }
    return state;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function assertV1Completion(result, events) {
  assert.deepEqual(result, { stopReason: "end_turn" });
  const started = new Set(
    events
      .filter((event) => event.sessionUpdate === "tool_call")
      .map((event) => event.toolCallId),
  );
  assert(
    events.some(
      (event) =>
        event.sessionUpdate === "tool_call_update" &&
        event.status === "completed" &&
        started.has(event.toolCallId),
    ),
    "successful Tool result missing",
  );
  const text = events
    .filter(
      (event) =>
        event.sessionUpdate === "agent_message_chunk" &&
        event.content.type === "text",
    )
    .map((event) => event.content.text)
    .join("");
  assert.match(text, /Stage 2 Runtime Tool execution completed\./u);
}

export async function openGatewayHttpClient(origin, login, agentId) {
  const updates = [];
  const client = acp
    .client()
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      updates.push(params),
    );
  const connection = client.connect(
    createHttpStream(`${origin}/api/app/agents/${agentId}/v1/acp`, {
      headers: {
        cookie: login.cookie,
        origin: gatewayOrigin(origin),
        "x-antnest-csrf-token": login.csrf,
      },
    }),
  );
  const request = (method, params) =>
    connection.agent.request(method, params, {
      cancellationSignal: AbortSignal.timeout(30000),
    });
  const close = async () => {
    connection.close();
    await connection.closed;
  };
  try {
    const initialized = await request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    assert.equal(initialized.protocolVersion, 1);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    request,
    close,
    async prompt() {
      const { sessionId } = await request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      const result = await request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Create the Stage 2 acceptance evidence file.",
          },
        ],
      });
      assertV1Completion(
        result,
        updates
          .filter((event) => event.sessionId === sessionId)
          .map((event) => event.update),
      );
      return sessionId;
    },
  };
}
