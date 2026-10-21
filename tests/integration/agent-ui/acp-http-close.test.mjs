import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { AcpHttpBridge } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { startBridgeTelemetry } from "../../../services/agent-ui/web/server/dist/telemetry.js";
import { createWorkspaceRuntime } from "../../../services/agent-ui/web/server/dist/workspace-runtime.js";
import { shutdownWorkspaceService } from "../../../services/agent-ui/web/server/dist/service-shutdown.js";
import { verifiedRequestContext } from "../../../services/agent-ui/web/server/dist/http/trusted-identity.js";
import { testScope, TestRequest } from "./auth-fixture.mjs";

const fromUi = createRequire(
  new URL("../../../services/agent-ui/web/package.json", import.meta.url),
);
const acp = await import(fromUi.resolve("@agentclientprotocol/sdk"));
const { AcpServer } = await import(
  fromUi.resolve("@agentclientprotocol/sdk/experimental/server")
);
const { createNodeHttpHandler } = await import(
  fromUi.resolve("@agentclientprotocol/sdk/experimental/node")
);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("fixture deadline exceeded")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(mode = "hold", options = {}) {
  const deleted = deferred(),
    release = deferred(),
    disconnected = deferred(),
    connected = deferred(),
    initializeStarted = deferred(),
    initializeHeaders = deferred(),
    initializeDisconnected = deferred(),
    releaseInitialize = deferred(),
    releaseHeaders = deferred(),
    threeStreams = deferred(),
    postHeld = deferred(),
    postDisconnected = deferred(),
    deleteAttempted = deferred(),
    releaseDelete = deferred();
  const streams = [];
  const streamClosures = [];
  let sessions = 0,
    holdPost,
    deleteAttempts = 0,
    deleteSettled = 0,
    deleteErrorCode;
  const agent = acp
    .agent({ name: "close-receipt-fixture" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      _meta:
        options.initialize === "capability"
          ? {}
          : {
              "antnest.dev/bridge": {
                intentReceipt: 1,
                targetCancel: 1,
                deliveryMark: 1,
              },
            },
    }))
    .onRequest(acp.methods.agent.session.new, () => ({
      sessionId: `session-${++sessions}`,
    }));
  const transport = new AcpServer({ agent });
  const handler = createNodeHttpHandler(transport);
  const requests = [];
  const initializations = [];
  const listener = createServer((request, response) => {
    if (options.workspace && request.url?.startsWith("/rpc/")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/rpc/agent-acp/get-agent-execution-state"
            ? {
                agent_id: "agent-1",
                access_allowed: true,
                configuration_revision: "a".repeat(64),
                availability: "ready",
                active_session_id: null,
                unavailable_reason: null,
              }
            : {},
        ),
      );
      return;
    }
    if (request.method !== "DELETE") {
      if (request.method === "POST" && !request.headers["acp-connection-id"])
        initializations.push({
          callerContext: request.headers["antnest-caller-context"],
        });
      if (
        request.method === "POST" &&
        !request.headers["acp-connection-id"] &&
        ["held-body", "held-headers"].includes(options.initialize)
      ) {
        request.resume();
        response.once("close", initializeDisconnected.resolve);
        initializeStarted.resolve();
        if (options.initialize === "held-body") {
          response.writeHead(200, {
            "content-type": "application/json",
            "acp-connection-id": "fixture-connection",
          });
          response.flushHeaders();
        }
        void releaseInitialize.promise.then(() => response.end("{}"));
        return;
      }
      if (
        request.method === "POST" &&
        request.headers["acp-connection-id"] &&
        holdPost
      ) {
        request.resume();
        response.once("close", postDisconnected.resolve);
        if (holdPost === "body") {
          response.writeHead(202);
          response.flushHeaders();
        }
        postHeld.resolve();
        void releaseInitialize.promise.then(() => response.end());
        return;
      }
      if (
        request.method === "POST" &&
        !request.headers["acp-connection-id"] &&
        ["no-id", "invalid-json", "unavailable"].includes(options.initialize)
      ) {
        request.resume();
        response
          .writeHead(options.initialize === "unavailable" ? 503 : 200, {
            "content-type": "application/json",
            ...(options.initialize === "invalid-json"
              ? { "acp-connection-id": "fixture-connection" }
              : {}),
          })
          .end(options.initialize === "invalid-json" ? "{" : "{}");
        return;
      }
      if (request.method === "GET") {
        streams.push(response);
        streamClosures.push(
          new Promise((resolve) => response.once("close", resolve)),
        );
        connected.resolve();
        if (streams.length === 3) threeStreams.resolve();
      }
      handler(request, response);
      return;
    }
    requests.push({
      headers: request.headers,
      method: request.method,
      path: request.url,
    });
    request.resume();
    response.once("close", disconnected.resolve);
    if (options.resetDelete) {
      request.socket.resetAndDestroy();
      deleted.resolve();
      return;
    }
    if (mode === "rejected" || options.deleteStatus) {
      response
        .writeHead(options.deleteStatus ?? 503, {
          "content-type": "application/json",
        })
        .end('{"code":"unavailable"}');
      deleted.resolve();
      return;
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.flushHeaders();
    deleted.resolve();
    void release.promise.then(() => {
      if (mode === "broken-body") response.destroy();
      else response.end("{}");
    });
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  let bridge;
  let opening;
  const close = async () => {
    release.resolve();
    releaseInitialize.resolve();
    releaseHeaders.resolve();
    releaseDelete.resolve();
    await opening?.catch(() => {});
    await Promise.resolve(bridge?.close()).catch(() => {});
    await transport.close();
    listener.closeAllConnections();
    if (listener.listening)
      await new Promise((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
  };
  try {
    opening = AcpHttpBridge.open({
      baseUrl: new URL(`http://127.0.0.1:${listener.address().port}`),
      scope:
        options.scope ??
        testScope({
          organizationId: "org-1",
          principalId: "user-1",
          agentId: "agent-1",
        }),
      callbacks: {
        update() {},
        requestPermission() {
          return { outcome: { outcome: "cancelled" } };
        },
      },
      fetchImpl: async (input, init) => {
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        if (method === "DELETE") {
          deleteAttempts++;
          deleteAttempted.resolve();
          if (options.holdDeleteBeforeFetch) await releaseDelete.promise;
        }
        let response;
        try {
          if (method === "DELETE" && Object.hasOwn(options, "deleteError"))
            throw options.deleteError;
          response = await fetch(input, init);
        } catch (error) {
          if (method === "DELETE" && options.resetDelete)
            deleteErrorCode = error?.cause?.code ?? error?.code;
          throw error;
        } finally {
          if (method === "DELETE") deleteSettled++;
        }
        if (
          options.initialize === "held-body" &&
          response.headers.has("acp-connection-id")
        )
          initializeHeaders.resolve();
        if (
          options.holdInitializeResponse &&
          method === "POST" &&
          response.headers.has("acp-connection-id")
        ) {
          initializeHeaders.resolve();
          await releaseHeaders.promise;
        }
        return response;
      },
      closeTimeoutMs: options.closeTimeoutMs,
      signal: options.signal,
    }).then((value) => {
      bridge = value;
      return value;
    });
    void opening.catch(() => {});
    const result = {
      get bridge() {
        return bridge;
      },
      opening,
      deleted: deleted.promise,
      disconnected: disconnected.promise,
      connected: connected.promise,
      initializeStarted: initializeStarted.promise,
      initializeHeaders: initializeHeaders.promise,
      initializeDisconnected: initializeDisconnected.promise,
      releaseHeaders: releaseHeaders.resolve,
      threeStreams: threeStreams.promise,
      streamClosures,
      holdWrites(mode) {
        holdPost = mode;
      },
      postHeld: postHeld.promise,
      postDisconnected: postDisconnected.promise,
      deleteAttempted: deleteAttempted.promise,
      releaseDelete: releaseDelete.resolve,
      get deleteAttempts() {
        return deleteAttempts;
      },
      get deleteSettled() {
        return deleteSettled;
      },
      get deleteErrorCode() {
        return deleteErrorCode;
      },
      async stopListener() {
        const stopped = new Promise((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
        listener.closeAllConnections();
        await stopped;
      },
      endStream() {
        for (const response of streams) response.end();
      },
      release: release.resolve,
      requests,
      initializations,
      close,
    };
    if (!options.deferOpen) await opening;
    return result;
  } catch (error) {
    await close();
    throw error;
  }
}

for (const mode of ["hold", "rejected"]) {
  test(`service shutdown retains real ACP ${mode} DELETE admission when telemetry fails`, async () => {
    const f = await fixture(mode);
    const calls = [],
      warnings = [],
      errors = [];
    const diagnostic = new Error("telemetry export unavailable");
    let pending,
      settled = false;
    try {
      await bounded(f.connected);
      pending = shutdownWorkspaceService({
        service: {
          async close() {
            calls.push("service:start");
            try {
              await f.bridge.close();
            } finally {
              calls.push("service:settled");
            }
          },
        },
        telemetry: {
          async shutdown() {
            calls.push("telemetry");
            throw diagnostic;
          },
        },
        authentication: {
          async close() {
            calls.push("authentication");
          },
        },
        reportError: (...values) => errors.push(values),
        reportWarning: (...values) => warnings.push(values),
      }).finally(() => {
        settled = true;
      });
      await bounded(f.deleted);
      if (mode === "hold") {
        assert.equal(
          settled,
          false,
          "must join the actual DELETE response body",
        );
        assert.deepEqual(calls, ["service:start"]);
        f.release();
      }
      assert.equal(await bounded(pending), mode === "hold" ? 0 : 1);
      assert.deepEqual(calls, [
        "service:start",
        "service:settled",
        "telemetry",
        "authentication",
      ]);
      assert.deepEqual(warnings, [
        ["Bridge telemetry shutdown warning", diagnostic],
      ]);
      assert.equal(errors.length, mode === "hold" ? 0 : 1);
      if (mode === "rejected") {
        assert.equal(errors[0][0], "Bridge shutdown failed");
        assert.match(errors[0][1].message, /cleanup failed/);
      }
      assert.equal(f.requests.length, 1, "one actual DELETE required");
      await bounded(Promise.all(f.streamClosures));
    } finally {
      f.release();
      await f.close();
      await pending;
    }
  });
}

test("ACP cancelled initialization waits for a late connection ID and its DELETE body", async () => {
  const controller = new AbortController();
  const f = await fixture("hold", {
    deferOpen: true,
    signal: controller.signal,
    holdInitializeResponse: true,
  });
  let settled = false;
  const opening = f.opening
    .then(
      () => true,
      () => false,
    )
    .finally(() => {
      settled = true;
    });
  try {
    await bounded(f.initializeHeaders);
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    f.releaseHeaders();
    await bounded(f.deleted);
    assert.equal(
      settled,
      false,
      "late cleanup is still owned by initialization",
    );
    f.release();
    assert.equal(await bounded(opening), false);
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

for (const initialize of ["held-headers", "held-body"]) {
  test(`ACP initialization cancellation joins the actual HTTP request (${initialize})`, async () => {
    const controller = new AbortController();
    const f = await fixture("hold", {
      initialize,
      deferOpen: true,
      signal: controller.signal,
    });
    let settled = false;
    const opening = f.opening
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        settled = true;
      });
    try {
      await bounded(f.initializeStarted);
      if (initialize === "held-body") await bounded(f.initializeHeaders);
      controller.abort();
      await bounded(f.initializeDisconnected);
      if (initialize === "held-body") {
        await bounded(f.deleted);
        assert.equal(settled, false);
        f.release();
      }
      assert.equal(await bounded(opening), false);
      assert.equal(f.requests.length, initialize === "held-body" ? 1 : 0);
    } finally {
      await f.close();
    }
  });
}

for (const mode of ["headers", "body"]) {
  test(`ACP close joins multiple actual SSE streams and an in-flight POST (${mode})`, async () => {
    const f = await fixture();
    let prompting;
    try {
      const first = await f.bridge.createSession();
      await f.bridge.createSession();
      await bounded(f.threeStreams);
      f.holdWrites(mode);
      prompting = f.bridge
        .prompt({
          sessionId: first.sessionId,
          intentId: "held-intent",
          expectedAppendVersion: 0,
          prompt: [{ type: "text", text: "held" }],
        })
        .then(
          () => true,
          () => false,
        );
      await bounded(f.postHeld);
      const closing = f.bridge.close();
      await bounded(f.deleted);
      f.release();
      await bounded(closing);
      assert.equal(await bounded(prompting), false);
      await bounded(f.postDisconnected);
      await bounded(Promise.all(f.streamClosures));
      assert.equal(f.requests.length, 1);
    } finally {
      await f.close();
      await prompting;
    }
  });
}

test("ACP close retains a DELETE failure from automatic SDK cleanup", async () => {
  const f = await fixture("rejected");
  try {
    await bounded(f.connected);
    f.endStream();
    await bounded(f.deleted);
    await bounded(f.bridge.closed);
    await assert.rejects(bounded(f.bridge.close()), /cleanup failed/);
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test("only completed peer-loss cleanup permits retirement while its original close still fails", async () => {
  const f = await fixture("hold", { holdDeleteBeforeFetch: true });
  try {
    await bounded(f.connected);
    await bounded(f.stopListener());
    await bounded(f.deleteAttempted);
    await bounded(f.bridge.closed);
    const closing = f.bridge.close();
    assert.equal(f.bridge.canReplaceAfterPeerLoss, false);
    assert.equal(f.deleteSettled, 0);
    f.releaseDelete();
    await assert.rejects(bounded(closing), /cleanup failed/);
    await bounded(Promise.all(f.streamClosures));
    assert.equal(f.deleteAttempts, 1);
    assert.equal(f.deleteSettled, 1);
    assert.equal(f.requests.length, 0, "no invented DELETE acknowledgement");
    assert.equal(f.bridge.canReplaceAfterPeerLoss, true);
    assert.equal(f.bridge.close(), closing);
    await assert.rejects(closing, /cleanup failed/);
  } finally {
    await f.close();
  }
});

const refused = () =>
  Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
const reset = () =>
  Object.assign(new Error("peer reset"), { code: "ECONNRESET" });
const mixedRefused = () =>
  Object.assign(new AggregateError([refused(), new Error("unknown leaf")]), {
    code: "ECONNREFUSED",
  });
for (const [name, error, qualified] of [
  ["direct refusal", refused, true],
  ["direct reset", reset, true],
  [
    "fetch reset",
    () => new TypeError("fetch failed", { cause: reset() }),
    true,
  ],
  [
    "only disconnected address failures",
    () =>
      new TypeError("fetch failed", {
        cause: Object.assign(new AggregateError([refused(), reset()]), {
          code: "ECONNRESET",
        }),
      }),
    true,
  ],
  [
    "reset with an unknown leaf",
    () =>
      new TypeError("fetch failed", {
        cause: Object.assign(
          new AggregateError([reset(), new Error("unknown")]),
          {
            code: "ECONNRESET",
          },
        ),
      }),
    false,
  ],
  [
    "reset with another network failure",
    () =>
      Object.assign(
        new AggregateError([
          reset(),
          Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        ]),
        { code: "ECONNRESET" },
      ),
    false,
  ],
  [
    "unknown reset wrapper",
    () => new Error("wrapper", { cause: reset() }),
    false,
  ],
  [
    "fetch refusal",
    () => new TypeError("fetch failed", { cause: refused() }),
    true,
  ],
  [
    "all-address refusal",
    () =>
      new TypeError("fetch failed", {
        cause: Object.assign(new AggregateError([refused(), refused()]), {
          code: "ECONNREFUSED",
        }),
      }),
    true,
  ],
  ["unknown", () => new Error("ECONNREFUSED"), false],
  ["unknown wrapper", () => new Error("wrapper", { cause: refused() }), false],
  [
    "mixed address failures",
    () => new TypeError("fetch failed", { cause: mixedRefused() }),
    false,
  ],
  [
    "unknown leaf",
    () =>
      Object.assign(new Error("refused", { cause: new Error("unknown") }), {
        code: "ECONNREFUSED",
      }),
    false,
  ],
  ["lookalike", () => ({ code: "ECONNREFUSED" }), false],
  ["undefined rejection", () => undefined, false],
  [
    "cycle",
    () => {
      const e = refused();
      e.cause = e;
      return e;
    },
    false,
  ],
  [
    "truncated chain",
    () => {
      let e = refused();
      for (let i = 0; i < 40; i++)
        e = new TypeError("fetch failed", { cause: e });
      return e;
    },
    false,
  ],
]) {
  test(`peer-loss retirement checks the complete owned DELETE cause: ${name}`, async () => {
    const f = await fixture("hold", { deleteError: error() });
    try {
      await bounded(f.connected);
      f.endStream();
      await bounded(f.bridge.closed);
      await assert.rejects(bounded(f.bridge.close()), /cleanup failed/);
      assert.equal(f.bridge.canReplaceAfterPeerLoss, qualified);
      assert.equal(f.deleteAttempts, 1);
      assert.equal(f.deleteSettled, 1);
    } finally {
      await f.close();
    }
  });
}

for (const status of [401, 403, 404, 500, 503]) {
  test(`peer-loss retirement does not waive an actual DELETE ${status}`, async () => {
    const f = await fixture("hold", { deleteStatus: status });
    try {
      await bounded(f.connected);
      f.endStream();
      await bounded(f.bridge.closed);
      await assert.rejects(bounded(f.bridge.close()), /cleanup failed/);
      assert.equal(f.bridge.canReplaceAfterPeerLoss, false);
      assert.equal(f.requests.length, 1);
    } finally {
      await f.close();
    }
  });
}

for (const [name, error] of [
  ["refused", refused],
  ["reset", reset],
])
  test(`requested close does not gain peer-loss qualification from a ${name} DELETE`, async () => {
    const f = await fixture("hold", { deleteError: error() });
    try {
      await bounded(f.connected);
      await assert.rejects(bounded(f.bridge.close()), /cleanup failed/);
      assert.equal(f.bridge.canReplaceAfterPeerLoss, false);
    } finally {
      await f.close();
    }
  });

for (const mode of ["refused", "reset"])
  test(`the first original Agent view after real ACP peer ${mode} creates one fresh connection`, async () => {
    const peers = [];
    const delegations = [];
    const runtime = createWorkspaceRuntime({
      connect: async (scope) => {
        const peer = await fixture("hold", {
          workspace: true,
          scope,
          holdDeleteBeforeFetch: peers.length === 0 && mode === "refused",
          resetDelete: peers.length === 0 && mode === "reset",
        });
        if (peers.length > 0) peer.release();
        peers.push(peer);
        return peer.bridge;
      },
    });
    const view = () => {
      const request = new TestRequest(
        "http://localhost/api/app/workspace/v1/agents/agent-1/view",
        {
          headers: {
            "x-antnest-organization-id": "org-1",
            "x-antnest-principal-id": "user-1",
            "x-antnest-agent-id": "agent-1",
          },
        },
      );
      delegations.push(verifiedRequestContext(request.headers).token);
      return runtime.handle(request);
    };
    try {
      assert.equal((await view()).status, 200);
      await bounded(peers[0].connected);
      if (mode === "refused") await bounded(peers[0].stopListener());
      else peers[0].endStream();
      await bounded(peers[0].deleteAttempted);
      await bounded(peers[0].bridge.closed);
      peers[0].releaseDelete();
      await assert.rejects(bounded(peers[0].bridge.close()), /cleanup failed/);
      if (mode === "reset")
        assert.equal(
          peers[0].deleteErrorCode,
          "ECONNRESET",
          "actual TCP reset required",
        );
      const response = await view();
      assert.equal(
        response.status,
        200,
        "the original GET must succeed without resending it",
      );
      await response.json();
      assert.equal(peers.length, 2, "no hidden business or connection retry");
      assert.notEqual(delegations[0], delegations[1]);
      assert.deepEqual(
        peers.map((peer) => peer.initializations),
        delegations.map((callerContext) => [{ callerContext }]),
        "each real ACP initialization must carry its original GET's delegation",
      );
      await assert.rejects(peers[0].bridge.close(), /cleanup failed/);
    } finally {
      for (const peer of peers) {
        peer.release();
        peer.releaseDelete();
      }
      await runtime.drain(100);
      for (const peer of peers) await peer.close();
    }
  });

test("ACP close joins cleanup already started by a failed SDK SSE stream", async () => {
  const f = await fixture();
  try {
    await bounded(f.connected);
    f.endStream();
    await bounded(f.deleted);
    await bounded(f.bridge.closed);
    let settled = false;
    const closing = Promise.resolve(f.bridge.close()).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    f.release();
    await bounded(closing);
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test("ACP cleanup deadline aborts the real held DELETE response before settling", async () => {
  const f = await fixture("hold", { closeTimeoutMs: 50 });
  try {
    const closing = Promise.resolve(f.bridge.close());
    const result = closing.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await bounded(f.deleted);
    assert.equal((await bounded(result)).ok, false);
    await bounded(f.disconnected);
    assert.equal(f.requests.length, 1, "cleanup must not retry");
  } finally {
    await f.close();
  }
});

for (const initialize of ["no-id", "unavailable"]) {
  test(`ACP failed initialization without a cleanup target settles (${initialize})`, async () => {
    const f = await fixture("hold", { initialize, deferOpen: true });
    try {
      await assert.rejects(bounded(f.opening));
      assert.equal(f.requests.length, 0);
    } finally {
      await f.close();
    }
  });
}

for (const initialize of ["invalid-json", "capability"]) {
  test(`ACP failed initialization joins its actual DELETE (${initialize})`, async () => {
    const f = await fixture("hold", { initialize, deferOpen: true });
    try {
      let settled = false;
      const result = f.opening
        .then(
          () => ({ ok: true }),
          (error) => ({ ok: false, error }),
        )
        .finally(() => {
          settled = true;
        });
      await bounded(f.deleted);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "open failure must join its cleanup");
      f.release();
      assert.equal((await bounded(result)).ok, false);
      assert.equal(f.requests.length, 1);
    } finally {
      await f.close();
    }
  });
}

test("ACP cleanup has its own root trace linked to initialization and parents the DELETE", async () => {
  const received = [];
  const collector = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    if (request.url === "/v1/traces")
      received.push(JSON.parse(Buffer.concat(parts).toString()));
    response.writeHead(200).end();
  });
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const telemetry = await startBridgeTelemetry({
    disabled: false,
    endpoint: new URL(`http://127.0.0.1:${collector.address().port}`),
    serviceName: "agent-ui-close-test",
  });
  let f;
  try {
    await telemetry.observeHttp(
      "GET",
      "/owner-initialization",
      async () => {
        f = await fixture();
        return 200;
      },
      {
        traceparent: "00-11111111111111111111111111111111-1111111111111111-01",
      },
    );
    await telemetry.observeHttp(
      "POST",
      "/unrelated-request",
      async () => {
        const closing = f.bridge.close();
        await bounded(f.deleted);
        f.release();
        await bounded(closing);
        return 200;
      },
      {
        traceparent: "00-22222222222222222222222222222222-2222222222222222-01",
      },
    );
    const observations = [];
    for (const [index, mode] of [
      "peer-stopped",
      "rejected",
      "broken-body",
      "no-target",
      "deadline",
    ].entries()) {
      let peer;
      const sourceTrace = (index + 3).toString(16).repeat(32);
      try {
        await telemetry.observeHttp(
          "GET",
          `/owner-${mode}`,
          async () => {
            peer = await fixture(
              ["peer-stopped", "no-target", "deadline"].includes(mode)
                ? "hold"
                : mode,
              {
                ...(mode === "peer-stopped"
                  ? { holdDeleteBeforeFetch: true }
                  : {}),
                ...(mode === "no-target"
                  ? { initialize: "no-id", deferOpen: true }
                  : {}),
                ...(mode === "deadline" ? { closeTimeoutMs: 50 } : {}),
              },
            );
            if (mode === "no-target")
              await assert.rejects(bounded(peer.opening));
            return mode === "no-target" ? 503 : 200;
          },
          { traceparent: `00-${sourceTrace}-1111111111111111-01` },
        );
        if (mode !== "no-target") {
          await bounded(peer.connected);
          if (mode === "peer-stopped") {
            await bounded(peer.stopListener());
            await bounded(peer.deleteAttempted);
          } else peer.endStream();
          let settled = false;
          const closing = Promise.resolve(peer.bridge.close())
            .then(
              () => ({ ok: true }),
              (error) => ({ ok: false, error }),
            )
            .finally(() => {
              settled = true;
            });
          if (mode === "peer-stopped") {
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(
              settled,
              false,
              "cleanup must join its attempted DELETE even after peer shutdown",
            );
            assert.equal(peer.deleteSettled, 0);
            peer.releaseDelete();
          } else {
            await bounded(peer.deleted);
            if (mode !== "deadline") peer.release();
          }
          const result = await bounded(closing);
          assert.equal(result.ok, false, "failed cleanup must remain failed");
          assert.match(result.error.message, /cleanup failed/);
          assert.equal(peer.deleteAttempts, 1, "cleanup must not retry");
          assert.equal(
            peer.deleteSettled,
            1,
            "attempted request must finish before cleanup settles",
          );
          if (mode === "deadline") await bounded(peer.disconnected);
          await bounded(Promise.all(peer.streamClosures));
        }
        observations.push({
          mode,
          sourceTrace,
          receiverCount: peer.requests.length,
        });
      } finally {
        await peer?.close();
      }
    }
    await telemetry.shutdown();
    const spans = received.flatMap((batch) =>
      batch.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    const attribute = (span, name) =>
      span.attributes.find((item) => item.key === name)?.value.stringValue;
    const initial = spans.find(
      (span) => attribute(span, "http.route") === "/owner-initialization",
    );
    const closing = spans.filter(
      (span) =>
        span.name === "agent_ui.acp.close" &&
        span.links.some((link) => link.traceId === initial.traceId),
    );
    assert.equal(
      closing.length,
      1,
      "exactly one actual cleanup span is required",
    );
    assert(
      !closing[0].parentSpanId,
      "cleanup must not extend an ended or unrelated HTTP parent",
    );
    assert.notEqual(closing[0].traceId, initial.traceId);
    assert.notEqual(closing[0].traceId, "22222222222222222222222222222222");
    assert.deepEqual(
      closing[0].links.map((link) => ({
        traceId: link.traceId,
        spanId: link.spanId,
      })),
      [{ traceId: initial.traceId, spanId: initial.spanId }],
    );
    assert.equal(
      f.requests[0].headers.traceparent,
      `00-${closing[0].traceId}-${closing[0].spanId}-01`,
    );
    assert.equal(
      attribute(closing[0], "antnest.ui.acp.close.trigger"),
      "requested",
    );
    assert.equal(
      attribute(closing[0], "antnest.ui.acp.close.outcome"),
      "closed",
    );
    assert(!JSON.stringify(closing).includes("fixture-connection"));
    const rawAttributes = (span) =>
      Object.fromEntries(
        span.attributes.map(({ key, value }) => [
          key,
          value.stringValue ?? value.boolValue ?? Number(value.intValue),
        ]),
      );
    const receipt = (span, expected) => {
      const actual = rawAttributes(span);
      for (const [name, value] of Object.entries(expected))
        assert.equal(
          actual[`antnest.ui.acp.close.${name}`],
          value,
          `missing actual cleanup receipt: ${name}`,
        );
      assert.equal(actual["antnest.ui.acp.close.pending_requests"], 0);
      assert.equal(actual["antnest.ui.acp.close.stream_joined"], true);
      assert.equal(actual["antnest.ui.acp.close.diagnostics_truncated"], false);
    };
    receipt(closing[0], {
      target_observed: true,
      delete_attempts: 1,
      delete_responses: 1,
      delete_completed: 1,
      delete_status: 202,
      failures: 0,
    });
    assert.equal(closing[0].events?.length ?? 0, 0);
    for (const { mode, sourceTrace, receiverCount } of observations) {
      const rows = spans.filter(
        (span) =>
          span.name === "agent_ui.acp.close" &&
          span.links.some((link) => link.traceId === sourceTrace),
      );
      assert.equal(rows.length, 1);
      const span = rows[0];
      assert(!span.parentSpanId);
      if (mode === "no-target") {
        receipt(span, {
          target_observed: false,
          delete_attempts: 0,
          delete_responses: 0,
          delete_completed: 0,
          delete_status: 0,
          failures: 0,
        });
        assert.equal(
          attribute(span, "antnest.ui.acp.close.outcome"),
          "no_target",
        );
        assert.equal(receiverCount, 0);
        assert.equal(span.events?.length ?? 0, 0);
        continue;
      }
      receipt(span, {
        target_observed: true,
        delete_attempts: 1,
        delete_responses: mode === "peer-stopped" ? 0 : 1,
        delete_completed: mode === "rejected" ? 1 : 0,
        delete_status:
          mode === "peer-stopped" ? 0 : mode === "rejected" ? 503 : 202,
        failures: mode === "deadline" ? 2 : 1,
      });
      assert.equal(attribute(span, "antnest.ui.acp.close.outcome"), "failed");
      assert.equal(span.status.code, 2, "original ERROR status must remain");
      assert.equal(receiverCount, mode === "peer-stopped" ? 0 : 1);
      assert.equal(span.events?.length, mode === "deadline" ? 2 : 1);
      for (const event of span.events)
        assert.equal(event.name, "antnest.ui.acp.close.failure");
      if (mode === "deadline")
        assert.equal(rawAttributes(span.events[0]).stage, "deadline");
      const failure = rawAttributes(span.events.at(-1));
      assert.equal(
        failure.stage,
        mode === "peer-stopped"
          ? "delete_request"
          : mode === "rejected"
            ? "delete_status"
            : "delete_body",
      );
      if (mode === "peer-stopped") {
        const causes = span.events[0].attributes
          .find(({ key }) => key === "causes")
          .value.arrayValue.values.map(({ stringValue }) => stringValue);
        assert(causes.includes("connection_refused"), JSON.stringify(causes));
      }
      assert(!JSON.stringify(span).includes("fixture-connection"));
      for (const value of ["org-1", "user-1", "agent-1"])
        assert(
          !JSON.stringify(span).includes(value),
          "close diagnostics must not carry identity labels",
        );
    }
  } finally {
    await f?.close();
    await telemetry.shutdown();
    collector.closeAllConnections();
    await new Promise((resolve) => collector.close(resolve));
  }
});

test("ACP close remains pending until the actual DELETE response body completes", async () => {
  const f = await fixture();
  let closing;
  try {
    let settled = false;
    closing = Promise.resolve(f.bridge.close()).then(() => {
      settled = true;
    });
    await bounded(f.deleted);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      "SDK local close is not the HTTP cleanup receipt",
    );
    f.release();
    await bounded(closing);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].path, "/v1/acp");
  } finally {
    f.release();
    await closing?.catch(() => {});
    await f.close();
  }
});

test("repeated ACP close calls join the same pending cleanup", async () => {
  const f = await fixture();
  try {
    const first = f.bridge.close(),
      second = f.bridge.close();
    assert(
      first instanceof Promise,
      "close must return its actual cleanup completion",
    );
    assert.equal(first, second);
    await bounded(f.deleted);
    f.release();
    await bounded(first);
    assert.equal(f.requests.length, 1);
  } finally {
    f.release();
    await f.close();
  }
});

for (const mode of ["rejected", "broken-body"]) {
  test(`ACP close surfaces an actual ${mode} DELETE response`, async () => {
    const f = await fixture(mode);
    try {
      const observed = Promise.resolve(f.bridge.close()).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      await bounded(f.deleted);
      f.release();
      const result = await bounded(observed);
      assert.equal(
        result.ok,
        false,
        "transport cleanup failure must not be swallowed",
      );
      assert(result.error instanceof Error);
    } finally {
      f.release();
      await f.close();
    }
  });
}
