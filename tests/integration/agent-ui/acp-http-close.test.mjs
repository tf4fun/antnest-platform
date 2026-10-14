import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { AcpHttpBridge } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { startBridgeTelemetry } from "../../../services/agent-ui/web/server/dist/telemetry.js";
import { testScope } from "./auth-fixture.mjs";

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
    postDisconnected = deferred();
  const streams = [];
  const streamClosures = [];
  let sessions = 0,
    holdPost;
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
  const listener = createServer((request, response) => {
    if (request.method !== "DELETE") {
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
    if (mode === "rejected") {
      response
        .writeHead(503, { "content-type": "application/json" })
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
    await opening?.catch(() => {});
    await Promise.resolve(bridge?.close()).catch(() => {});
    await transport.close();
    listener.closeAllConnections();
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  };
  try {
    opening = AcpHttpBridge.open({
      baseUrl: new URL(`http://127.0.0.1:${listener.address().port}`),
      scope: testScope({
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
        const response = await fetch(input, init);
        if (
          options.initialize === "held-body" &&
          response.headers.has("acp-connection-id")
        )
          initializeHeaders.resolve();
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
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
      endStream() {
        for (const response of streams) response.end();
      },
      release: release.resolve,
      requests,
      close,
    };
    if (!options.deferOpen) await opening;
    return result;
  } catch (error) {
    await close();
    throw error;
  }
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
    const closing = spans.filter((span) => span.name === "agent_ui.acp.close");
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
