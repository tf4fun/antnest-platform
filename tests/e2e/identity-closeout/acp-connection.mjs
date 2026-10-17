import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { observeSocket, requestWithin } from "../acp-closeout/connection.mjs";

import { observeStream } from "../acp-commands/transport.mjs";
import { createNotificationEvidence } from "../acp-commands/notification-evidence.mjs";
import { createSessionCloseObserver } from "./session-close.mjs";

export const gateway = "http://edge-gateway:8080";

// Only snapshots issued by an actual private connection may authorize Trace
// correlation. The public recorder is an observation helper, not an authority.
const notificationReceipts = new WeakMap();

export function inspectPrivateNotificationReceipt(receipt) {
  const proof = notificationReceipts.get(receipt);
  assert(proof, "original private notification receipt required");
  assert(
    proof.closedAtCapture && proof.closed() && proof.pending() === 0,
    "notification receipt requires a successfully closed terminal connection",
  );
  assert.equal(
    JSON.stringify(proof.current()),
    proof.inventoryJSON,
    "notification inventory changed after receipt capture",
  );
  assert(
    proof.inventory.every(
      (entry) =>
        entry.status === "write_completed" &&
        entry.wireObserved === true &&
        entry.writeOutcome === "completed",
    ),
    "notification inventory contains an incomplete or failed write",
  );
  assert(
    proof.inventory[receipt.index] === receipt &&
      receipt.origin === "notify" &&
      typeof receipt.method === "string" &&
      receipt.method.length > 0 &&
      typeof receipt.sessionId === "string" &&
      receipt.sessionId.length > 0,
    "notification receipt is not an original Session notification",
  );
  assert.equal(
    proof.inventory.filter(
      (entry) =>
        entry.method === receipt.method &&
        entry.sessionId === receipt.sessionId,
    ).length,
    1,
    "duplicate notification keys are ambiguous on one connection",
  );
  return receipt;
}

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
  assert(
    options.captureRawFrames === undefined ||
      typeof options.captureRawFrames === "boolean",
    "captureRawFrames must be a boolean",
  );
  const boundary =
    options.boundary === undefined ? "gateway" : options.boundary;
  assert(
    ["gateway", "private-acp"].includes(boundary),
    "unknown ACP connection boundary",
  );
  assert(
    options.captureNotifications === undefined ||
      typeof options.captureNotifications === "boolean",
    "captureNotifications must be a boolean",
  );
  assert(
    !options.captureNotifications || boundary === "private-acp",
    "notification capture requires private WebSocket ACP",
  );
  const privateTransport =
    boundary === "private-acp"
      ? privateConfiguration(version, agent, cookie, options)
      : undefined;
  const acp = version === 1 ? v1 : v2;
  const traceID =
    privateTransport?.upgrade.traceID ?? randomBytes(16).toString("hex");
  const parent = privateTransport ? undefined : randomBytes(8).toString("hex");
  const notifications = options.captureNotifications
    ? createNotificationEvidence({
        agentId: agent,
        version,
        connectionTraceID: traceID,
        clientSpanID: privateTransport.upgrade.clientSpanID,
      })
    : undefined;
  let closeCode, actualTraceID, upgradeStatus, socket, closing, localCloseCause;
  let closureSucceeded = false;
  const notificationSnapshot = () => {
    const inventory = notifications.snapshot();
    const proof = {
      inventory,
      inventoryJSON: JSON.stringify(inventory),
      closedAtCapture: closureSucceeded,
      closed: () => closureSucceeded,
      pending: () => notifications.pending,
      current: () => notifications.snapshot(),
    };
    for (const receipt of inventory) notificationReceipts.set(receipt, proof);
    return inventory;
  };
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
  const rawFrames = options.captureRawFrames ? [] : undefined;
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
          rawFrames,
          notifications,
        ),
      );
  } catch (error) {
    privateTransport?.upgrade.end(undefined);
    throw error;
  }
  const close = () => {
    notifications?.stop();
    peerClose.markLocalClose();
    privateTransport?.upgrade.end(upgradeStatus, "cancelled");
    const wasOpen = !connection.signal.aborted;
    connection.close();
    // The SDK may already have closed because of a protocol or write failure.
    // Only the original reason created by our own close proves local closure.
    if (wasOpen) localCloseCause = connection.signal.reason;
  };
  const closeAndWait = ({ graceMs = 1000 } = {}) => {
    assert(Number.isFinite(graceMs) && graceMs > 0 && graceMs <= 5000);
    return (closing ??= (async () => {
      const errors = [];
      let receipt;
      try {
        close();
        try {
          receipt = await peerClose.wait(graceMs);
        } catch {
          // A peer can stop reading instead of replying to the close frame.
          // Terminate the actual transport and still join its close event.
          socket.terminate();
          receipt = await peerClose.wait(5000);
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        await notifications?.join();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(
          errors,
          "private ACP close and notification cleanup failed",
        );
      closureSucceeded = true;
      return receipt;
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
  const client = {
    boundary,
    ...(privateTransport
      ? {
          clientSpanID: privateTransport.upgrade.clientSpanID,
          isLocalCloseError: (error) =>
            localCloseCause !== undefined && error === localCloseCause,
        }
      : {}),
    get observedConnectionTraceID() {
      return actualTraceID;
    },
    get traceID() {
      return observedTraceID();
    },
    version,
    updates,
    ...(rawFrames ? { rawFrames } : {}),
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
      notifications
        ? notifications.notify(
            acp.methods.agent.session[name],
            params,
            (method, input) => connection.agent.notify(method, input),
          )
        : connection.agent.notify(acp.methods.agent.session[name], params),
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
  if (notifications)
    Object.defineProperties(client, {
      notifications: { enumerable: true, get: notificationSnapshot },
      lastNotification: {
        enumerable: true,
        get: () => notificationSnapshot().at(-1),
      },
    });
  return client;
}
