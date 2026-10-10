import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { observeSocket, requestWithin } from "../acp-closeout/connection.mjs";
import { until } from "../acp-closeout/support.mjs";
import { observeStream, observeFetch } from "./transport.mjs";

const gateway = process.env.TEST_GATEWAY_URL ?? "http://edge-gateway:8080";
export function commandConnection(profile, agentId, browser) {
  const sdk = profile.version === 1 ? v1 : v2;
  const connectionTraceID = randomBytes(16).toString("hex");
  const updates = [],
    observed = [];
  const closed = new AbortController();
  const url = `${gateway}/api/app/agents/${agentId}/v${profile.version}/acp`;
  const headers = { Cookie: browser.cookie, Origin: gatewayOrigin(gateway) };
  const stream = profile.http
    ? createHttpStream(url, {
        headers: {
          ...headers,
          "X-Antnest-CSRF-Token": browser.cookies.get("antnest_csrf"),
        },
        // Let Gateway create a fresh root; do not invent an unexported HTTP parent.
        fetch: observeFetch(fetch, observed),
      })
    : observeStream(
        createWebSocketStream(url.replace("http:", "ws:"), {
          WebSocket: observeSocket(WebSocket, closed, () => undefined),
          headers: {
            ...headers,
            traceparent: `00-${connectionTraceID}-${randomBytes(8).toString("hex")}-01`,
          },
        }),
        observed,
      );
  const connection = sdk
    .client()
    .onNotification(sdk.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(sdk.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(stream);
  const client = {
    updates,
    agentId,
    transport: profile.http ? "http" : "websocket",
    connectionTraceID,
    close: () => connection.close(),
    initialize: () =>
      request(
        sdk.methods.agent.initialize,
        profile.version === 1
          ? { protocolVersion: sdk.PROTOCOL_VERSION, clientCapabilities: {} }
          : {
              protocolVersion: sdk.PROTOCOL_VERSION,
              info: { name: "command-acceptance", version: "1" },
              capabilities: {},
            },
      ),
    request: (name, params, timeout) =>
      request(sdk.methods.agent.session[name], params, timeout),
  };
  async function request(method, params, timeout = 15000) {
    const offset = observed.length;
    try {
      return await requestWithin(
        (options) => connection.agent.request(method, params, options),
        closed.signal,
        client.close,
        timeout,
      );
    } finally {
      await until(
        () => observed.length > offset,
        "actual outgoing SDK request",
        5000,
      );
      assert.equal(
        observed.length - offset,
        1,
        "missing or duplicated outgoing SDK request",
      );
      client.lastRequest = {
        ...observed[offset],
        agentId,
        transport: client.transport,
        ...(profile.http ? {} : { connectionTraceID }),
      };
    }
  }
  return client;
}
