import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  acp,
  authHeaders,
  bounded,
  context,
  deferred,
  grant,
  httpFixture,
  turn,
} from "./private-acp-http.fixture.mjs";

const moduleURL = new URL("./private-acp-http.mjs", import.meta.url);
const implementation = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
function create(endpoint, options) {
  assert.equal(
    typeof implementation.createPrivateACPHTTP,
    "function",
    "private HTTP lifecycle helper is required",
  );
  return implementation.createPrivateACPHTTP(endpoint, options);
}
function client(fixture, options = {}) {
  const { connectionForBinding, ...transportOptions } = options;
  const http = fixture.register(
    create(fixture.endpoint, {
      telemetry: fixture.telemetry,
      headersFor: authHeaders,
      ...transportOptions,
    }),
  );
  const connection = acp.client().connect(http.stream);
  http.bindConnection(
    connectionForBinding ? connectionForBinding(connection) : connection,
  );
  const opening = connection.agent
    .request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    .then((value) => {
      http.completeInitialization();
      return value;
    });
  void opening.catch(() => {});
  return { http, connection, opening };
}
const newSession = (connection) =>
  connection.agent.request(acp.methods.agent.session.new, {
    cwd: "/workspace",
    mcpServers: [],
  });
const prompt = (connection, sessionId) =>
  connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "PRIVATE-HTTP-BUSINESS-BODY" }],
  });

test(
  "actual HTTP initialize, ACK and multiple Session SSEs retain unique exported CLIENTs",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t);
    const fetched = [];
    let authCalls = 0;
    const c = client(f, {
      headersFor: () => {
        authCalls++;
        return authHeaders();
      },
      fetchImpl: (input, init) => {
        fetched.push(init);
        return fetch(input, init);
      },
    });
    assert.equal((await bounded(c.opening)).protocolVersion, 1);
    const one = await bounded(newSession(c.connection));
    const two = await bounded(newSession(c.connection));
    assert.equal(
      (await bounded(prompt(c.connection, one.sessionId))).stopReason,
      "end_turn",
    );
    assert.equal(
      (await bounded(prompt(c.connection, two.sessionId))).stopReason,
      "end_turn",
    );
    await bounded(
      c.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: one.sessionId,
      }),
    );
    const live = c.http.snapshot();
    assert.equal(live.initialized, true);
    assert.equal(
      live.requests.filter(
        (r) => r.method === "GET" && r.bodyOutcome === "pending",
      ).length,
      3,
    );
    const closing = c.http.closeAndWait();
    assert.strictEqual(c.http.closeAndWait(), closing);
    await bounded(closing);
    await f.joinResponses();
    await f.telemetry.flush();
    const receipt = c.http.snapshot();
    assert.equal(receipt.pendingRequests, 0);
    assert.equal(receipt.streamJoined, true);
    assert.deepEqual(receipt.failures, []);
    assert.equal(
      receipt.requests.filter((r) => r.method === "DELETE").length,
      1,
    );
    assert.equal(
      receipt.requests.find((r) => r.method === "DELETE").bodyOutcome,
      "eof",
    );
    assert.equal(
      receipt.requests.find((r) => r.rpcMethod === "initialize").status,
      200,
    );
    assert(
      receipt.requests
        .filter((r) => r.method === "POST" && r.connectionID)
        .every((r) => r.status === 202),
    );
    assert(
      receipt.requests
        .filter((r) => r.method === "GET")
        .every((r) => r.bodyOutcome === "cancelled"),
    );
    assert.equal(authCalls, f.records.length);
    assert(
      fetched.every((r) => r.credentials === "omit" && r.redirect === "error"),
    );
    assert(
      f.records.every(
        (r) =>
          !r.headers.cookie &&
          r.headers["antnest-caller-context"] === context &&
          r.headers["antnest-service-authorization"] === grant,
      ),
    );
    const spans = f.spans();
    assert.equal(spans.length, f.records.length);
    assert.equal(new Set(spans.map((s) => s.traceId)).size, spans.length);
    for (const actual of f.records) {
      const [, traceID, spanID] = actual.headers.traceparent.split("-");
      const span = spans.find(
        (s) => s.traceId === traceID && s.spanId === spanID,
      );
      assert(span, "wire context must identify its actual exported CLIENT");
      assert.equal(span.kind, 3);
      assert(!span.parentSpanId);
      assert.equal(span.resource["service.name"], "antnest-private-acp-client");
      assert.equal(span.attributes["http.request.method"], actual.method);
      assert.notEqual(span.status?.code, 2);
    }
    for (const sent of fetched.filter((r) => r.method === "POST")) {
      assert.equal(typeof sent.body, "string");
      const message = JSON.parse(sent.body);
      const headers = new Headers(sent.headers);
      const traceID = headers.get("traceparent").split("-")[1];
      const actual = receipt.requests.find((r) => r.traceID === traceID);
      assert.equal(actual.requestID, message.id ?? null);
      assert.equal(actual.rpcMethod, message.method ?? null);
      assert.equal(actual.rpcSessionID, message.params?.sessionId ?? null);
      assert.equal(actual.connectionID, headers.get("acp-connection-id"));
      assert.equal(actual.sessionID, headers.get("acp-session-id"));
    }
    const safe = JSON.stringify({ receipt, exports: f.exports });
    for (const secret of [
      context,
      grant,
      grant.slice("Bearer ".length),
      "PRIVATE-HTTP-BUSINESS-BODY",
      "PRIVATE-HTTP-COOKIE",
    ])
      assert(
        !safe.includes(secret),
        "request receipts and OTLP must not retain credentials or business contents",
      );
    receipt.requests.length = 0;
    assert(
      c.http.snapshot().requests.length > 0,
      "receipt copies cannot mutate owned evidence",
    );
  },
);

for (const mode of ["held-headers", "held-body"]) {
  test(
    `SDK closed does not finish ${mode} DELETE cleanup`,
    { timeout: 10000 },
    async (t) => {
      const f = await httpFixture(t, { deleteMode: mode });
      const c = client(f);
      await bounded(c.opening);
      let finished = false;
      const closing = c.http.closeAndWait().finally(() => {
        finished = true;
      });
      await bounded(c.connection.closed);
      await bounded(f.deleteStarted);
      await turn();
      assert.equal(finished, false);
      f.releaseDelete();
      await bounded(closing);
      await f.joinResponses();
      assert.equal(c.http.snapshot().pendingRequests, 0);
      assert.equal(f.records.filter((r) => r.method === "DELETE").length, 1);
    },
  );
}

for (const status of [200, 204, 404, 503]) {
  test(
    `DELETE ${status} cannot become a successful close`,
    { timeout: 10000 },
    async (t) => {
      const f = await httpFixture(t, {
        deleteStatus: status,
        deleteBody: "PRIVATE-DELETE-ERROR",
      });
      const c = client(f);
      await bounded(c.opening);
      await assert.rejects(
        bounded(c.http.closeAndWait()),
        /private ACP HTTP cleanup failed/,
      );
      await f.joinResponses();
      await f.telemetry.flush();
      const receipt = c.http.snapshot();
      assert.equal(receipt.pendingRequests, 0);
      assert(receipt.failures.some((e) => e.phase === "delete_status"));
      const span = f
        .spans()
        .find((s) => s.attributes["http.request.method"] === "DELETE");
      assert.equal(
        Number(span.attributes["http.response.status_code"]),
        status,
      );
      assert.equal(span.status.code, 2);
      assert(
        !JSON.stringify({ receipt, exports: f.exports }).includes(
          "PRIVATE-DELETE-ERROR",
        ),
      );
    },
  );
}

test(
  "automatic DELETE failure survives SDK error cleanup",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t, { deleteStatus: 503 });
    const c = client(f);
    await bounded(c.opening);
    await bounded(newSession(c.connection));
    f.endConnectionStream();
    await bounded(f.deleteStarted);
    await bounded(c.connection.closed);
    await assert.rejects(
      bounded(c.http.closeAndWait()),
      /private ACP HTTP cleanup failed/,
    );
    assert(c.http.snapshot().failures.some((e) => e.phase === "delete_status"));
    assert.equal(f.records.filter((r) => r.method === "DELETE").length, 1);
  },
);

test(
  "an unconsumed 202 ACK is cancelled and joined without inventing EOF",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t);
    const c = client(f);
    await bounded(c.opening);
    const session = await bounded(newSession(c.connection));
    f.holdAcknowledgements();
    assert.equal(
      (await bounded(prompt(c.connection, session.sessionId))).stopReason,
      "end_turn",
    );
    await bounded(f.ackHeld);
    await bounded(c.http.closeAndWait());
    await f.joinResponses();
    const ack = c.http
      .snapshot()
      .requests.find((r) => r.rpcMethod === "session/prompt");
    assert.equal(ack.status, 202);
    assert.equal(ack.bodyOutcome, "cancelled");
    assert.equal(c.http.snapshot().pendingRequests, 0);
  },
);

test(
  "DELETE body reset is retained even while ordinary traffic is cancelled",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t, { deleteMode: "reset" });
    const received = deferred();
    const c = client(f, {
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init);
        if (init.method === "DELETE") received.resolve();
        return response;
      },
    });
    await bounded(c.opening);
    const closing = c.http.closeAndWait();
    await bounded(received.promise);
    f.releaseDelete();
    await assert.rejects(bounded(closing), /private ACP HTTP cleanup failed/);
    assert(c.http.snapshot().failures.some((e) => e.phase === "delete_body"));
    assert.equal(c.http.snapshot().pendingRequests, 0);
  },
);

test(
  "cleanup deadline aborts and joins the actual DELETE body",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t, { deleteMode: "held-body" });
    const c = client(f, { closeTimeoutMs: 80 });
    await bounded(c.opening);
    await assert.rejects(
      bounded(c.http.closeAndWait()),
      /private ACP HTTP cleanup failed/,
    );
    await f.joinResponses();
    assert.equal(c.http.snapshot().pendingRequests, 0);
    assert(c.http.snapshot().failures.some((e) => e.phase === "deadline"));
    await f.telemetry.flush();
    const deletion = c.http
      .snapshot()
      .requests.find((r) => r.method === "DELETE");
    assert.equal(deletion.bodyOutcome, "cancelled");
    const span = f.spans().find((s) => s.spanId === deletion.clientSpanID);
    assert.equal(Number(span.attributes["http.response.status_code"]), 202);
    assert.equal(
      span.status.code,
      2,
      "incomplete DELETE must remain a CLIENT failure",
    );
  },
);

test(
  "DELETE deadline is an ERROR even when the body source cancels without a read error",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t, { deleteMode: "held-body" });
    const c = client(f, {
      closeTimeoutMs: 80,
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init);
        if (init.method !== "DELETE") return response;
        const reader = response.body.getReader();
        void reader.closed.catch(() => {});
        let cancelling = false;
        return new Response(
          new ReadableStream(
            {
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (cancelling) return;
                  if (next.done) controller.close();
                  else controller.enqueue(next.value);
                } catch (error) {
                  if (!cancelling) controller.error(error);
                }
              },
              async cancel() {
                cancelling = true;
                try {
                  await reader.cancel();
                } catch (error) {
                  if (!init.signal.aborted || error !== init.signal.reason)
                    throw error;
                }
                reader.releaseLock();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: response.status, headers: response.headers },
        );
      },
    });
    await bounded(c.opening);
    await assert.rejects(
      bounded(c.http.closeAndWait()),
      /private ACP HTTP cleanup failed/,
    );
    await f.joinResponses();
    await f.telemetry.flush();
    const deletion = c.http
      .snapshot()
      .requests.find((r) => r.method === "DELETE");
    assert.equal(deletion.bodyOutcome, "cancelled");
    const span = f.spans().find((s) => s.spanId === deletion.clientSpanID);
    assert.equal(Number(span.attributes["http.response.status_code"]), 202);
    assert.equal(span.status.code, 2);
  },
);

for (const when of ["before", "after"]) {
  test(
    `synchronous connection.close failure ${when} SDK close still joins actual HTTP`,
    { timeout: 10000 },
    async (t) => {
      const f = await httpFixture(t);
      const c = client(f, {
        connectionForBinding: (actual) => ({
          closed: actual.closed,
          close() {
            if (when === "after") actual.close();
            throw new Error("PRIVATE-CLOSE-SECRET");
          },
        }),
      });
      await bounded(c.opening);
      await bounded(newSession(c.connection));
      await assert.rejects(bounded(c.http.closeAndWait()), (error) => {
        assert.match(error.message, /private ACP HTTP cleanup failed/);
        assert(!inspect(error).includes("PRIVATE-CLOSE-SECRET"));
        return true;
      });
      await f.joinResponses();
      assert.equal(c.http.snapshot().pendingRequests, 0);
      assert.equal(c.http.snapshot().streamJoined, true);
      assert(
        c.http.snapshot().failures.some((e) => e.phase === "connection_close"),
      );
    },
  );
}

for (const phase of ["closePeer", "shutdownTelemetry"]) {
  test(
    `fixture ${phase} rejection does not skip remaining real resources`,
    { timeout: 10000 },
    async (t) => {
      const hooks = [];
      const injected = new Error(`fixture ${phase} failure`);
      const f = await httpFixture(
        {
          after(callback) {
            hooks.push(callback);
          },
        },
        {
          [phase]: async (close) => {
            await close();
            throw injected;
          },
        },
      );
      // This independent fallback owns resources even when the teardown under
      // test is broken. It does not supply the assertions below.
      t.after(async () => {
        await f.resources.peer.close();
        await f.telemetry.shutdown();
        f.resources.server.closeAllConnections();
        if (f.resources.server.listening)
          await new Promise((resolve) => f.resources.server.close(resolve));
        while (f.resources.pending.size)
          await Promise.allSettled([...f.resources.pending]);
      });
      const c = client(f);
      await bounded(c.opening);
      await bounded(newSession(c.connection));
      await assert.rejects(bounded(hooks[0]()), (error) => {
        assert.deepEqual(error.errors, [injected]);
        return true;
      });
      assert.equal(
        f.resources.server.listening,
        false,
        "the actual listener must close after an earlier closer failed",
      );
      assert.equal(f.resources.pending.size, 0);
      await f.joinResponses();
    },
  );
}

for (const phase of ["read", "release"]) {
  test(
    `independent raw reader ${phase} failure survives normal close without leaking its error`,
    { timeout: 10000 },
    async (t) => {
      const f = await httpFixture(t);
      const entered = deferred(),
        release = deferred();
      f.releaseDuringCleanup(release.resolve);
      const c = client(f, {
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          if (
            init.method !== "GET" ||
            new Headers(init.headers).has("acp-session-id")
          )
            return response;
          const reader = response.body.getReader();
          let held = false;
          // Decorate only this response's actual reader. All bytes and socket I/O
          // still come from fetch; the injected failure belongs to its read/release.
          response.body.getReader = () => ({
            closed: reader.closed,
            async read() {
              const next = await reader.read();
              if (phase === "read" && !held && !next.done) {
                held = true;
                entered.resolve();
                await release.promise;
                throw new Error("PRIVATE-READER-SECRET");
              }
              return next;
            },
            cancel: () => reader.cancel(),
            releaseLock() {
              reader.releaseLock();
              if (phase === "release") throw new Error("PRIVATE-READER-SECRET");
            },
          });
          return response;
        },
      });
      await bounded(c.opening);
      const rpc = newSession(c.connection);
      void rpc.catch(() => {});
      if (phase === "read") await bounded(entered.promise);
      else await bounded(rpc);
      let finished = false;
      const closing = c.http.closeAndWait().finally(() => {
        finished = true;
      });
      void closing.catch(() => {});
      if (phase === "read") {
        await turn();
        assert.equal(finished, false);
      }
      release.resolve();
      await assert.rejects(bounded(closing), (error) => {
        assert.match(error.message, /private ACP HTTP cleanup failed/);
        assert(!inspect(error).includes("PRIVATE-READER-SECRET"));
        return true;
      });
      await Promise.allSettled([rpc]);
      await f.joinResponses();
      await f.telemetry.flush();
      const receipt = c.http.snapshot();
      assert.equal(receipt.pendingRequests, 0);
      assert(
        receipt.failures.some(
          (e) => e.phase === "response_body" && e.reason === phase,
        ),
      );
      assert(
        !JSON.stringify({ receipt, exports: f.exports }).includes(
          "PRIVATE-READER-SECRET",
        ),
      );
    },
  );
}

for (const mode of ["held-headers", "held-body"]) {
  test(
    `initialization timeout cancels and joins ${mode}`,
    { timeout: 10000 },
    async (t) => {
      const f = await httpFixture(t, { initializeMode: mode });
      const c = client(f, { initializationTimeoutMs: 80 });
      await bounded(f.initializeStarted);
      await assert.rejects(bounded(c.opening));
      await bounded(c.http.closeAndWait());
      await f.joinResponses();
      assert.equal(c.http.snapshot().initialized, false);
      assert.equal(c.http.snapshot().streamJoined, true);
      assert.equal(c.http.snapshot().pendingRequests, 0);
      assert.equal(
        f.records.filter((r) => r.method === "DELETE").length,
        mode === "held-body" ? 1 : 0,
      );
    },
  );
}

test(
  "late initialize response still owns one complete DELETE after caller abort",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t);
    const received = deferred(),
      release = deferred();
    const stop = new AbortController();
    f.releaseDuringCleanup(release.resolve);
    const c = client(f, {
      signal: stop.signal,
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init);
        if (
          init.method === "POST" &&
          !new Headers(init.headers).has("acp-connection-id")
        ) {
          received.resolve();
          await release.promise;
        }
        return response;
      },
    });
    await bounded(received.promise);
    stop.abort();
    await assert.rejects(bounded(c.opening));
    let joined = false;
    const closing = c.http.closeAndWait().finally(() => {
      joined = true;
    });
    await turn();
    assert.equal(joined, false);
    release.resolve();
    await bounded(closing);
    await f.joinResponses();
    assert.equal(f.records.filter((r) => r.method === "DELETE").length, 1);
    assert.equal(c.http.snapshot().pendingRequests, 0);
  },
);

test(
  "private HTTP rejects Cookie and transport header overrides before wire traffic",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t);
    for (const name of [
      "Cookie",
      "traceparent",
      "Acp-Connection-Id",
      "Acp-Session-Id",
      "Authorization",
    ]) {
      const c = client(f, {
        headersFor: () => ({
          ...authHeaders(),
          [name]: "PRIVATE-HEADER-SECRET",
        }),
      });
      await assert.rejects(bounded(c.opening));
      await assert.rejects(bounded(c.http.closeAndWait()));
      assert(!inspect(c.http.snapshot()).includes("PRIVATE-HEADER-SECRET"));
    }
    assert.equal(f.records.length, 0);
  },
);

test("private HTTP validates endpoint and bounded budgets without leaking input", async (t) => {
  const f = await httpFixture(t);
  assert.equal(typeof implementation.createPrivateACPHTTP, "function");
  for (const endpoint of [
    "http://user:PRIVATE-URL-SECRET@",
    "http://user:PRIVATE-URL-SECRET@localhost/v1/acp",
    "http://localhost/v2/acp",
    "http://localhost/v1/acp?secret=PRIVATE-URL-SECRET",
  ]) {
    assert.throws(
      () =>
        create(endpoint, { telemetry: f.telemetry, headersFor: authHeaders }),
      (error) => {
        assert(!inspect(error).includes("PRIVATE-URL-SECRET"));
        return true;
      },
    );
  }
  for (const closeTimeoutMs of [0, -1, 5001, NaN, Infinity])
    assert.throws(() =>
      create(f.endpoint, {
        telemetry: f.telemetry,
        headersFor: authHeaders,
        closeTimeoutMs,
      }),
    );
});

for (const length of [65536, 65537]) {
  test(
    `DELETE body limit is enforced at ${length} bytes`,
    { timeout: 10000 },
    async (t) => {
      const f = await httpFixture(t, { deleteBody: "x".repeat(length) });
      const c = client(f);
      await bounded(c.opening);
      if (length === 65536) await bounded(c.http.closeAndWait());
      else
        await assert.rejects(
          bounded(c.http.closeAndWait()),
          /private ACP HTTP cleanup failed/,
        );
      await f.joinResponses();
      await f.telemetry.flush();
      const receipt = c.http.snapshot();
      const deletion = receipt.requests.find((r) => r.method === "DELETE");
      assert.equal(deletion.bytes, length);
      assert.equal(deletion.bodyOutcome, length === 65536 ? "eof" : "failed");
      assert.equal(receipt.pendingRequests, 0);
      assert.equal(
        f.spans().find((s) => s.attributes["http.request.method"] === "DELETE")
          .status?.code === 2,
        length > 65536,
      );
    },
  );
}

test(
  "cancellation waits for the original asynchronous credentials provider",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t);
    const entered = deferred(),
      aborted = deferred(),
      release = deferred();
    f.releaseDuringCleanup(release.resolve);
    const stop = new AbortController();
    let providerSettled = false;
    const c = client(f, {
      signal: stop.signal,
      headersFor: async ({ method, signal }) => {
        assert.equal(method, "POST");
        assert(signal instanceof AbortSignal);
        entered.resolve();
        signal.addEventListener("abort", aborted.resolve, { once: true });
        await release.promise;
        providerSettled = true;
        signal.throwIfAborted();
        return authHeaders();
      },
    });
    await bounded(entered.promise);
    stop.abort();
    await bounded(aborted.promise);
    await assert.rejects(bounded(c.opening));
    let finished = false;
    const closing = c.http.closeAndWait().finally(() => {
      finished = true;
    });
    await turn();
    assert.equal(finished, false);
    assert.equal(providerSettled, false);
    release.resolve();
    await bounded(closing);
    assert.equal(providerSettled, true);
    assert.equal(f.records.length, 0);
    assert.equal(c.http.snapshot().pendingRequests, 0);
  },
);

test(
  "initialization signal is detached after success and credentials can refresh",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t);
    const stop = new AbortController();
    let current = context;
    const c = client(f, {
      signal: stop.signal,
      headersFor: () => ({
        ...authHeaders(),
        "Antnest-Caller-Context": current,
      }),
    });
    await bounded(c.opening);
    current = "PRIVATE-REFRESHED-CCT.header.payload";
    stop.abort();
    await bounded(newSession(c.connection));
    assert.equal(c.http.snapshot().closing, false);
    await bounded(c.http.closeAndWait());
    const post = f.records.find(
      (r) => r.method === "POST" && r.headers["acp-connection-id"],
    );
    assert.equal(post.headers["antnest-caller-context"], current);
    const deletion = f.records.find((r) => r.method === "DELETE");
    assert.equal(deletion.headers["antnest-caller-context"], current);
    assert.equal(c.http.snapshot().failures.length, 0);
  },
);

test(
  "independent SSE reset remains an error after SDK automatic close",
  { timeout: 10000 },
  async (t) => {
    const f = await httpFixture(t);
    const c = client(f);
    await bounded(c.opening);
    await bounded(newSession(c.connection));
    f.resetConnectionStream();
    await bounded(c.connection.closed);
    await assert.rejects(
      bounded(c.http.closeAndWait()),
      /private ACP HTTP cleanup failed/,
    );
    await f.joinResponses();
    await f.telemetry.flush();
    const receipt = c.http.snapshot();
    assert(receipt.failures.some((e) => e.phase === "response_body"));
    assert.equal(receipt.pendingRequests, 0);
    const get = receipt.requests.find(
      (r) => r.method === "GET" && !r.sessionID,
    );
    assert.equal(get.status, 200);
    assert.equal(get.bodyOutcome, "failed");
    assert.equal(
      f.spans().find((s) => s.spanId === get.clientSpanID).status.code,
      2,
    );
  },
);

for (const rejection of ["undefined", "null", "error", "hostile"]) {
  test(
    `independent body cancellation rejection ${rejection} is joined and sanitized`,
    { timeout: 10000 },
    async (t) => {
      const f = await httpFixture(t);
      const release = deferred(),
        cancelling = deferred();
      f.releaseDuringCleanup(release.resolve);
      let getterReads = 0,
        cancelled = false;
      const hostile = Object.create(null);
      for (const key of ["name", "message", "cause", "stack", "code"])
        Object.defineProperty(hostile, key, {
          get() {
            getterReads++;
            throw new Error("PRIVATE-CANCEL-SECRET");
          },
        });
      const error =
        rejection === "undefined"
          ? undefined
          : rejection === "null"
            ? null
            : rejection === "hostile"
              ? hostile
              : new Error("PRIVATE-CANCEL-SECRET");
      const c = client(f, {
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          if (
            init.method !== "GET" ||
            new Headers(init.headers).has("acp-session-id")
          )
            return response;
          const source = response.body.getReader();
          void source.closed.catch(() => {});
          return new Response(
            new ReadableStream(
              {
                async pull(output) {
                  try {
                    const next = await source.read();
                    if (cancelled) return;
                    if (next.done) output.close();
                    else output.enqueue(next.value);
                  } catch (cause) {
                    if (!cancelled) output.error(cause);
                  }
                },
                async cancel() {
                  cancelled = true;
                  cancelling.resolve();
                  try {
                    await source.cancel();
                  } catch {
                    /* Original fetch abort is not the injected failure. */
                  }
                  await release.promise;
                  source.releaseLock();
                  throw error;
                },
              },
              { highWaterMark: 0 },
            ),
            { status: response.status, headers: response.headers },
          );
        },
      });
      await bounded(c.opening);
      await bounded(newSession(c.connection));
      let finished = false;
      const closing = c.http.closeAndWait().finally(() => {
        finished = true;
      });
      // Observe the rejection before releasing the controlled source.
      void closing.catch(() => {});
      await bounded(cancelling.promise);
      await turn();
      assert.equal(finished, false);
      release.resolve();
      await assert.rejects(bounded(closing), (value) => {
        assert.match(value.message, /private ACP HTTP cleanup failed/);
        assert(!inspect(value).includes("PRIVATE-CANCEL-SECRET"));
        return true;
      });
      await f.joinResponses();
      await f.telemetry.flush();
      const receipt = c.http.snapshot();
      assert(
        receipt.failures.some(
          (e) => e.phase === "response_body" && e.reason === "cancel",
        ),
      );
      assert.equal(receipt.pendingRequests, 0);
      assert.equal(getterReads, 0);
      assert(
        !JSON.stringify({ receipt, exports: f.exports }).includes(
          "PRIVATE-CANCEL-SECRET",
        ),
      );
    },
  );
}
