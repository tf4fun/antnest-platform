import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { GatewayClient, verifyIdentityTraces } from "./support.mjs";

const gateway = "http://edge-gateway:8080";
const agent = process.env.ANTNEST_STAGE3_AGENT_ID;
assert(agent, "Stage 3 Agent ID required");
const credentials = {
  organization_slug: "stage3",
  email: "stage3-user@example.com",
  password: "stage3-user-password",
};
const evidence = [];
const expectations = [];
const secrets = [credentials.password];

function connect(version, cookie) {
  const acp = version === 1 ? v1 : v2;
  const traceID = randomBytes(16).toString("hex");
  const parent = randomBytes(8).toString("hex");
  let closeCode;
  class ObservedSocket extends WebSocket {
    constructor(...args) {
      super(...args);
      this.once("close", (code) => {
        closeCode = code;
      });
    }
  }
  const updates = [];
  const connection = acp
    .client()
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(
      createWebSocketStream(
        `${gateway.replace("http:", "ws:")}/api/app/agents/${agent}/v${version}/acp`,
        {
          WebSocket: ObservedSocket,
          headers: {
            Cookie: cookie,
            Origin: gateway,
            traceparent: `00-${traceID}-${parent}-01`,
          },
        },
      ),
    );
  const request = (method, params) =>
    connection.agent.request(method, params, {
      signal: AbortSignal.timeout(15000),
    });
  return {
    traceID,
    updates,
    close: () => connection.close(),
    get closeCode() {
      return closeCode;
    },
    request: (name, params) => request(acp.methods.agent.session[name], params),
    initialize: () =>
      request(
        acp.methods.agent.initialize,
        version === 1
          ? { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }
          : {
              protocolVersion: acp.PROTOCOL_VERSION,
              info: { name: "identity-closeout", version: "1" },
              capabilities: {},
            },
      ),
  };
}

for (const version of [1, 2]) {
  const browser = new GatewayClient(gateway);
  await browser.request("/api/session/login", { body: credentials });
  secrets.push(browser.cookie, ...browser.cookies.values());
  const originalCookie = browser.cookie;
  const connection = connect(version, originalCookie);
  let sessionId;
  try {
    await connection.initialize();
    ({ sessionId } = await connection.request("new", {
      cwd: "/workspace",
      mcpServers: [],
    }));
    await browser.request("/api/session", { method: "DELETE", status: 204 });
    // Send a real SDK prompt only after authoritative logout has completed.
    await assert.rejects(
      connection.request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "revoked-session-must-not-create-run" }],
      }),
    );
    assert.equal(
      connection.closeCode,
      1008,
      "revoked connection did not close with policy violation",
    );
    assert.equal(
      connection.updates.length,
      0,
      "revoked prompt produced Session updates",
    );
  } finally {
    connection.close();
  }
  expectations.push({
    traceID: connection.traceID,
    repository: "identity.repository.resolve_access_token",
  });

  // A new login must recover the same durable Session without the rejected input.
  await browser.request("/api/session/login", { body: credentials });
  secrets.push(browser.cookie, ...browser.cookies.values());
  const recovered = connect(version, browser.cookie);
  try {
    await recovered.initialize();
    await recovered.request(version === 1 ? "load" : "resume", {
      sessionId,
      cwd: "/workspace",
      mcpServers: [],
      ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    assert(
      recovered.updates.every(
        ({ update }) => update.sessionUpdate === "state_update",
      ),
      "rejected prompt entered durable Session history",
    );
  } finally {
    recovered.close();
    await browser.request("/api/session", { method: "DELETE", status: 204 });
  }
  evidence.push({
    version,
    revoked_prompt_rejected: true,
    close_code: connection.closeCode,
    empty_session_recovered: true,
  });
}

const traces = await verifyIdentityTraces(
  "http://jaeger:16686",
  expectations,
  secrets,
);
process.stdout.write(
  JSON.stringify({
    status: "passed",
    acp_session_revocation: evidence,
    traces,
  }) + "\n",
);
