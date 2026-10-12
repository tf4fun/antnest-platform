import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { observeStream } from "../acp-commands/transport.mjs";
import { createSessionCloseObserver } from "../identity-closeout/session-close.mjs";
export { collectLifecycleACPTrace } from "./acp-trace.mjs";

// Resolve the same pinned SDK as the service, without a second package manifest.
const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const acp = await import(require.resolve("@agentclientprotocol/sdk"));
const { createWebSocketStream } = await import(
  require.resolve("@agentclientprotocol/sdk/experimental/ws-client")
);
const { WebSocket } = require("ws");

export function ownerStream(
  gateway,
  agentID,
  cookie,
  open = createWebSocketStream,
  Socket = WebSocket,
  traceID = randomBytes(16).toString("hex"),
) {
  return open(
    `${gateway.replace(/^http/u, "ws")}/api/app/agents/${agentID}/v1/acp`,
    {
      WebSocket: Socket,
      headers: {
        Cookie: cookie,
        Origin: gatewayOrigin(gateway),
        ...(traceID === null
          ? {}
          : {
              traceparent: `00-${traceID}-${randomBytes(8).toString("hex")}-01`,
            }),
      },
    },
  );
}

export function requestOptions(timeout, signal) {
  signal?.throwIfAborted();
  return {
    cancellationSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  };
}

export function connectOwner(
  gateway,
  agentID,
  cookie,
  signal,
  { captureWire = false, injectTraceParent = true } = {},
) {
  signal?.throwIfAborted();
  const updates = [];
  const requests = [],
    connectionTraceID = randomBytes(16).toString("hex");
  const closed = new AbortController();
  const peerClose = createSessionCloseObserver();
  const wire = { started_at: performance.now(), frames: [] };
  let closeCode, handshakeStatus, actualTraceID, socket;
  // The SDK removes its error listener on close, but Node ws can still emit a
  // handshake error. Keep that error connected to pending request rejection.
  class OwnedSocket extends WebSocket {
    constructor(...args) {
      super(...args);
      socket = this;
      this.once("upgrade", (response) => {
        actualTraceID = response.headers["x-antnest-trace-id"];
        handshakeStatus = response.statusCode;
        wire.upgrade = {
          at: performance.now(),
          trace_id: actualTraceID,
          status: handshakeStatus,
        };
      });
      this.on("message", (data) => {
        if (captureWire)
          wire.frames.push({
            direction: "receive",
            at: performance.now(),
            raw: data.toString(),
          });
      });
      this.on("error", (error) => closed.abort(error));
      this.on("close", (code, reason) => {
        closeCode = code;
        peerClose.record(code, reason);
        closed.abort(new Error("ACP peer closed"));
      });
      this.on("unexpected-response", (_request, response) => {
        handshakeStatus = response.statusCode;
        response.resume();
        this.terminate();
      });
    }

    send(data, ...args) {
      if (captureWire)
        wire.frames.push({
          direction: "send",
          at: performance.now(),
          raw: data.toString(),
        });
      return super.send(data, ...args);
    }
  }
  const connection = acp
    .client()
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const option = params.options.find((o) => o.kind === "allow_once");
      assert(option, "fixture tool did not offer one-use permission");
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    })
    .connect(
      observeStream(
        ownerStream(
          gateway,
          agentID,
          cookie,
          createWebSocketStream,
          OwnedSocket,
          injectTraceParent ? connectionTraceID : null,
        ),
        requests,
      ),
    );
  let disposed = false;
  const close = () => {
    if (disposed) return;
    disposed = true;
    peerClose.markLocalClose();
    signal?.removeEventListener("abort", close);
    closed.abort(signal?.reason ?? new Error("ACP connection closed"));
    connection.close();
  };
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();
  const request = async (method, params, timeout = 15000) => {
    const options = requestOptions(
      timeout,
      signal ? AbortSignal.any([signal, closed.signal]) : closed.signal,
    );
    const cancel = options.cancellationSignal;
    // SDK cancellation is cooperative. A silent peer must not keep the fixture
    // alive; expire this connection without pretending to cancel its durable Run.
    return new Promise((resolve, reject) => {
      const abort = () => {
        reject(cancel.reason);
        close();
      };
      cancel.addEventListener("abort", abort, { once: true });
      connection.agent.request(method, params, options).then(
        (value) => {
          cancel.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          cancel.removeEventListener("abort", abort);
          reject(error);
        },
      );
      if (cancel.aborted) abort();
    });
  };
  return {
    updates,
    requests,
    wire,
    get connectionTraceID() {
      return (
        actualTraceID ?? (injectTraceParent ? connectionTraceID : undefined)
      );
    },
    agentId: agentID,
    transport: "websocket",
    close,
    waitForClose: (timeout) => peerClose.wait(timeout),
    async closeAndWait() {
      close();
      try {
        return await peerClose.wait(3000);
      } catch (error) {
        socket?.terminate();
        await peerClose.wait(1000);
        throw error;
      }
    },
    get closeCode() {
      return closeCode;
    },
    get handshakeStatus() {
      return handshakeStatus;
    },
    cancel: (sessionId, expectedRunId) =>
      connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId,
        ...(expectedRunId === undefined
          ? {}
          : {
              _meta: { "antnest.dev/target-cancel": { expectedRunId } },
            }),
      }),
    initialize: (meta) =>
      request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        ...(meta === undefined ? {} : { _meta: meta }),
      }),
    request: (method, params, timeout) =>
      request(acp.methods.agent.session[method], params, timeout),
  };
}
