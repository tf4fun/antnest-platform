import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

export const gateway = "http://edge-gateway:8080";

export function connectACP(version, agent, cookie) {
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
  const request = (method, params, timeout = 15000) =>
    connection.agent.request(method, params, {
      signal: AbortSignal.timeout(timeout),
    });
  return {
    traceID,
    updates,
    close: () => connection.close(),
    get closeCode() {
      return closeCode;
    },
    request: (name, params, timeout) =>
      request(acp.methods.agent.session[name], params, timeout),
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
