import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

// Resolve the same pinned SDK as the service, without a second package manifest.
const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
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
) {
  return open(
    `${gateway.replace("http:", "ws:")}/api/app/agents/${agentID}/v1/acp`,
    {
      WebSocket: Socket,
      headers: {
        Cookie: cookie,
        Origin: gateway,
        traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
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

export function connectOwner(gateway, agentID, cookie, signal) {
  signal?.throwIfAborted();
  const updates = [];
  const closed = new AbortController();
  let closeCode, handshakeStatus;
  // The SDK removes its error listener on close, but Node ws can still emit a
  // handshake error. Keep that error connected to pending request rejection.
  class OwnedSocket extends WebSocket {
    constructor(...args) {
      super(...args);
      this.on("error", (error) => closed.abort(error));
      this.on("close", (code) => {
        closeCode = code;
      });
      this.on("unexpected-response", (_request, response) => {
        handshakeStatus = response.statusCode;
        response.resume();
        this.terminate();
      });
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
      ownerStream(gateway, agentID, cookie, createWebSocketStream, OwnedSocket),
    );
  let disposed = false;
  const close = () => {
    if (disposed) return;
    disposed = true;
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
    close,
    get closeCode() {
      return closeCode;
    },
    get handshakeStatus() {
      return handshakeStatus;
    },
    cancel: (sessionId) =>
      connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }),
    initialize: () =>
      request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    request: (method, params, timeout) =>
      request(acp.methods.agent.session[method], params, timeout),
  };
}
