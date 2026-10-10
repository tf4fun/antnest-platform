import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { observeSocket, requestWithin } from "../acp-closeout/connection.mjs";

import { observeStream } from "../acp-commands/transport.mjs";

export const gateway = "http://edge-gateway:8080";

export function connectACP(version, agent, cookie, options = {}) {
  const acp = version === 1 ? v1 : v2;
  const traceID = randomBytes(16).toString("hex");
  const parent = randomBytes(8).toString("hex");
  let closeCode;
  const closed = new AbortController();
  const ObservedSocket = observeSocket(WebSocket, closed, (code) => {
    closeCode = code;
  });
  const updates = [],
    requests = [];
  const connection = acp
    .client()
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(
      acp.methods.client.session.requestPermission,
      options.requestPermission ??
        (() => ({
          outcome: { outcome: "cancelled" },
        })),
    )
    .connect(
      observeStream(
        createWebSocketStream(
          `${gateway.replace("http:", "ws:")}/api/app/agents/${agent}/v${version}/acp`,
          {
            WebSocket: ObservedSocket,
            headers: {
              ...options.headers,
              Cookie: cookie,
              Origin: gatewayOrigin(gateway),
              ...(options.injectTraceParent === false
                ? {}
                : { traceparent: `00-${traceID}-${parent}-01` }),
            },
          },
        ),
        requests,
      ),
    );
  const request = (method, params, timeout = 15000) =>
    requestWithin(
      (requestOptions) =>
        connection.agent.request(method, params, requestOptions),
      closed.signal,
      () => connection.close(),
      timeout,
    );
  return {
    traceID,
    updates,
    requests,
    agentId: agent,
    connectionTraceID: traceID,
    transport: "websocket",
    close: () => connection.close(),
    get closeCode() {
      return closeCode;
    },
    request: (name, params, timeout) =>
      request(acp.methods.agent.session[name], params, timeout),
    notify: (name, params) =>
      connection.agent.notify(acp.methods.agent.session[name], params),
    initialize: () =>
      request(
        acp.methods.agent.initialize,
        version === 1
          ? {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: options.clientCapabilities ?? {},
            }
          : {
              protocolVersion: acp.PROTOCOL_VERSION,
              info: { name: "identity-closeout", version: "1" },
              capabilities: {},
            },
      ),
  };
}
