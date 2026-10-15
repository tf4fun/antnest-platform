import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { observeSocket, requestWithin } from "../acp-closeout/connection.mjs";

import { observeStream } from "../acp-commands/transport.mjs";
import { createSessionCloseObserver } from "./session-close.mjs";

export const gateway = "http://edge-gateway:8080";

function privateConfiguration(version, agent, cookie, options) {
  assert([1, 2].includes(version), "unsupported private ACP version");
  assert(typeof agent === "string" && agent.trim().length > 0);
  assert(cookie === undefined, "private ACP must not receive a browser Cookie");
  assert(
    options.headers === undefined,
    "private ACP header overrides are forbidden",
  );
  assert(
    options.injectTraceParent === undefined,
    "private ACP requires its actual CLIENT context",
  );
  assert(
    typeof options.context === "string" &&
      options.context.length <= 8192 &&
      /^[\x21-\x7e]+$/u.test(options.context),
    "private ACP requires the issued workspace caller context",
  );
  const authorization = options.authorization;
  assert(
    authorization &&
      typeof authorization === "object" &&
      Object.keys(authorization).length === 1 &&
      typeof authorization["Antnest-Service-Authorization"] === "string" &&
      /^Bearer [A-Za-z0-9_-]{43}$/u.test(
        authorization["Antnest-Service-Authorization"],
      ),
    "private ACP requires the Agent UI workload grant without extra headers",
  );
  assert(typeof options.endpoint === "string" && options.endpoint.length > 0);
  let endpoint;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new Error("invalid private ACP endpoint");
  }
  assert(
    ["http:", "https:", "ws:", "wss:"].includes(endpoint.protocol) &&
      endpoint.pathname === `/v${version}/acp` &&
      !endpoint.search &&
      !endpoint.hash &&
      !endpoint.username &&
      !endpoint.password,
    "private ACP endpoint must select its exact workspace protocol route",
  );
  if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
  if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
  assert(
    typeof options.telemetry?.startUpgrade === "function" &&
      typeof options.telemetry?.flush === "function",
    "private ACP requires an exporting CLIENT telemetry provider",
  );
  const upgrade = options.telemetry.startUpgrade(version);
  return {
    url: endpoint.href,
    upgrade,
    headers: {
      ...authorization,
      "Antnest-Caller-Context": options.context,
      traceparent: upgrade.traceparent,
    },
  };
}

export function connectACP(version, agent, cookie, options = {}) {
  const boundary =
    options.boundary === undefined ? "gateway" : options.boundary;
  assert(
    ["gateway", "private-acp"].includes(boundary),
    "unknown ACP connection boundary",
  );
  const privateTransport =
    boundary === "private-acp"
      ? privateConfiguration(version, agent, cookie, options)
      : undefined;
  const acp = version === 1 ? v1 : v2;
  const traceID =
    privateTransport?.upgrade.traceID ?? randomBytes(16).toString("hex");
  const parent = privateTransport ? undefined : randomBytes(8).toString("hex");
  let closeCode, actualTraceID, upgradeStatus, socket, closing;
  const closed = new AbortController();
  const peerClose = createSessionCloseObserver();
  const SocketBase = observeSocket(WebSocket, closed, (code, reason) => {
    closeCode = code;
    peerClose.record(code, reason);
  });
  class ObservedSocket extends SocketBase {
    constructor(...args) {
      super(...args);
      socket = this;
      this.once("upgrade", (response) => {
        if (privateTransport) upgradeStatus = response.statusCode;
        else actualTraceID = response.headers["x-antnest-trace-id"];
      });
      if (privateTransport) {
        // ws emits upgrade before validating Accept and subprotocol. Only open
        // proves that the official transport accepted the handshake.
        this.once("open", () => privateTransport.upgrade.end(upgradeStatus));
        // Record the HTTP rejection before observeSocket terminates the socket.
        this.prependOnceListener("unexpected-response", (_request, response) =>
          privateTransport.upgrade.end(response.statusCode),
        );
        this.prependOnceListener("error", () =>
          privateTransport.upgrade.end(upgradeStatus, "failed"),
        );
        this.once("close", () =>
          privateTransport.upgrade.end(upgradeStatus, "cancelled"),
        );
      }
    }
  }
  const updates = [],
    requests = [];
  let connection;
  try {
    connection = acp
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
            privateTransport?.url ??
              `${gateway.replace("http:", "ws:")}/api/app/agents/${agent}/v${version}/acp`,
            {
              WebSocket: ObservedSocket,
              ...(privateTransport ? { cookies: "omit" } : {}),
              headers: privateTransport?.headers ?? {
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
  } catch (error) {
    privateTransport?.upgrade.end(undefined);
    throw error;
  }
  const close = () => {
    peerClose.markLocalClose();
    privateTransport?.upgrade.end(upgradeStatus, "cancelled");
    connection.close();
  };
  const closeAndWait = ({ graceMs = 1000 } = {}) => {
    assert(Number.isFinite(graceMs) && graceMs > 0 && graceMs <= 5000);
    return (closing ??= (async () => {
      close();
      try {
        return await peerClose.wait(graceMs);
      } catch {
        // A peer can stop reading instead of replying to the close frame.
        // Terminate the actual transport and still join its close event.
        socket.terminate();
        return peerClose.wait(5000);
      }
    })());
  };
  const observedTraceID = () =>
    actualTraceID ??
    (options.injectTraceParent === false ? undefined : traceID);
  const request = (method, params, timeout = 15000) =>
    requestWithin(
      (requestOptions) =>
        connection.agent.request(method, params, requestOptions),
      closed.signal,
      close,
      timeout,
    );
  return {
    boundary,
    ...(privateTransport
      ? { clientSpanID: privateTransport.upgrade.clientSpanID }
      : {}),
    get observedConnectionTraceID() {
      return actualTraceID;
    },
    get traceID() {
      return observedTraceID();
    },
    version,
    updates,
    requests,
    agentId: agent,
    get connectionTraceID() {
      return observedTraceID();
    },
    transport: "websocket",
    close,
    closeAndWait,
    waitForClose: (timeoutMs) => peerClose.wait(timeoutMs),
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
