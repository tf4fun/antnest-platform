import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createPublicationProxy } from "./publication-proxy.mjs";

const applyPath = "/rpc/agent-acp/apply-execution-snapshot";
const snapshot = Buffer.from(
  ` \n${JSON.stringify({
    organization_id: "org-1",
    revision: 7,
    providers: [],
    models: [],
    agents: [],
  })}\n`,
);
const acknowledgement = Buffer.from(
  '{"organization_id":"org-1","applied_revision":7}',
);
const digest = (body) => createHash("sha256").update(body).digest("hex");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within(promise, label, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not finish`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function bytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function client(
  origin,
  path,
  { method = "POST", body = snapshot, headers = {}, end = true } = {},
) {
  const joined = deferred();
  const result = {
    status: undefined,
    headers: undefined,
    body: undefined,
    error: undefined,
    complete: false,
  };
  let response;
  const endpoint = new URL(origin);
  const req = request({
    hostname: endpoint.hostname,
    port: endpoint.port,
    path,
    method,
    headers: { connection: "close", ...headers },
  });
  req.on("error", (error) => {
    result.error = error;
  });
  req.once("response", (res) => {
    response = res;
    result.status = res.statusCode;
    result.headers = res.headers;
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("error", (error) => {
      result.error ??= error;
    });
    res.once("close", () => {
      result.body = Buffer.concat(chunks);
      result.complete = res.complete;
      joined.resolve(result);
    });
  });
  req.once("close", () => {
    if (!response) joined.resolve(result);
  });
  if (end) req.end(body);
  return {
    req,
    done: joined.promise,
    destroy() {
      response?.destroy();
      req.destroy();
    },
  };
}

async function withProxy(action, { delayMs, reply } = {}) {
  const received = [];
  const clients = [];
  const sockets = new Set();
  const handlers = new Set();
  const releases = [];
  const handlerErrors = [];
  const upstream = createServer((req, res) => {
    const work = (async () => {
      const body = await bytes(req);
      const entry = {
        path: req.url,
        method: req.method,
        headers: req.headers,
        body,
        req,
        res,
      };
      received.push(entry);
      if (reply) await reply(entry);
      else
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(acknowledgement);
    })();
    handlers.add(work);
    void work.then(
      () => handlers.delete(work),
      (error) => {
        handlers.delete(work);
        handlerErrors.push(error);
        res.destroy();
      },
    );
  });
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let proxy;
  let closing;
  const closeProxy = () =>
    (closing ??= Promise.resolve().then(() => proxy.close()));
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    proxy = createPublicationProxy({
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      ...(delayMs === undefined ? {} : { delayMs }),
    });
    proxy.server.listen(0, "127.0.0.1");
    await once(proxy.server, "listening");
    const origin = `http://127.0.0.1:${proxy.server.address().port}`;
    const open = (path, options) => {
      const call = client(origin, path, options);
      clients.push(call);
      return call;
    };
    const state = async () => {
      const response = await within(
        open("/status", { method: "GET", body: undefined }).done,
        "status request",
      );
      assert.equal(response.status, 200);
      assert.equal(response.complete, true);
      return JSON.parse(response.body.toString());
    };
    const waitState = async (predicate, label) => {
      const deadline = performance.now() + 5000;
      do {
        const status = await state();
        if (predicate(status)) return status;
      } while (performance.now() < deadline);
      throw new Error(`${label} was not observed`);
    };
    await action({
      proxy,
      received,
      open,
      state,
      waitState,
      closeProxy,
      releases,
    });
  } finally {
    for (const release of releases) release();
    for (const call of clients) call.destroy();
    for (const socket of sockets) socket.destroy();
    try {
      if (proxy) await closeProxy();
    } finally {
      proxy?.server.closeAllConnections();
      if (proxy?.server.listening)
        await new Promise((resolve) => proxy.server.close(resolve));
      upstream.closeAllConnections();
      if (upstream.listening)
        await new Promise((resolve) => upstream.close(resolve));
      await Promise.all(clients.map((call) => call.done));
      await Promise.allSettled([...handlers]);
    }
    assert.deepEqual(
      handlerErrors,
      [],
      "the owned upstream handlers must finish without hidden errors",
    );
  }
}

function assertTerminal(attempt, cancelled) {
  assert.equal(typeof attempt.id, "string");
  assert.notEqual(attempt.id.length, 0);
  assert.equal(attempt.cancelled, cancelled);
  assert.equal(Number.isFinite(attempt.receivedAt), true);
  assert.equal(Number.isFinite(attempt.completedAt), true);
  assert.ok(attempt.completedAt >= attempt.receivedAt);
  let previous = attempt.receivedAt;
  for (const field of [
    "delayStartedAt",
    "forwardedAt",
    "upstreamCompletedAt",
    "completedAt",
  ]) {
    if (attempt[field] === null) continue;
    assert.equal(Number.isFinite(attempt[field]), true, field);
    assert.ok(attempt[field] >= previous, `${field} must be monotonic`);
    previous = attempt[field];
  }
}

test(
  "publication proxy exposes the default 2000ms delay without proxying its status read",
  { timeout: 10000 },
  async () => {
    await withProxy(async ({ proxy, state, received }) => {
      const status = await state();
      assert.equal(status.delayMs, 2000);
      assert.equal(status.active, 0);
      assert.deepEqual(status.attempts, []);
      assert.deepEqual(proxy.attempts, []);
      assert.deepEqual(received, []);
    });
  },
);

test(
  "apply waits for the complete original body and delays before transparently forwarding bytes, headers and status",
  { timeout: 10000 },
  async () => {
    const replyBody = gzipSync(
      Buffer.from(' \n{"code":"fixture_conflict","message":"🧪"}\n'),
    );
    await withProxy(
      async ({ open, received, waitState, state }) => {
        const call = open(applyPath, {
          end: false,
          headers: {
            "content-type": "application/json; charset=utf-8",
            accept: "application/json",
            "antnest-service-authorization": "Bearer fixture-only-credential",
            traceparent:
              "00-11111111111111111111111111111111-2222222222222222-01",
            tracestate: "fixture=one",
            "x-fixture-request": ["first", "second"],
          },
        });
        call.req.write(snapshot.subarray(0, 8));
        const uploading = await waitState(
          (value) => value.active === 1 && value.attempts.length === 1,
          "partial upload",
        );
        assert.equal(uploading.attempts[0].delayStartedAt, null);
        assert.equal(uploading.attempts[0].forwardedAt, null);
        assert.equal(received.length, 0);
        call.req.end(snapshot.subarray(8));
        const response = await within(
          call.done,
          "delayed publication response",
        );
        assert.equal(response.complete, true);
        assert.equal(response.status, 409);
        assert.deepEqual(response.body, replyBody);
        assert.equal(
          response.headers["content-type"],
          "application/json; charset=utf-8",
        );
        assert.equal(response.headers["content-encoding"], "gzip");
        assert.equal(
          response.headers["content-length"],
          String(replyBody.length),
        );
        assert.equal(response.headers["x-fixture-response"], "kept");
        assert.deepEqual(response.headers["set-cookie"], [
          "fixture_one=1",
          "fixture_two=2",
        ]);
        assert.equal(received.length, 1);
        assert.equal(received[0].path, applyPath);
        assert.equal(received[0].method, "POST");
        assert.deepEqual(received[0].body, snapshot);
        for (const [name, value] of Object.entries({
          "content-type": "application/json; charset=utf-8",
          accept: "application/json",
          "antnest-service-authorization": "Bearer fixture-only-credential",
          traceparent:
            "00-11111111111111111111111111111111-2222222222222222-01",
          tracestate: "fixture=one",
          "x-fixture-request": "first, second",
        }))
          assert.equal(received[0].headers[name], value, name);
        const finished = await waitState(
          (value) => value.active === 0,
          "publication completion",
        );
        assert.equal(finished.attempts.length, 1);
        const attempt = finished.attempts[0];
        assertTerminal(attempt, false);
        assert.equal(attempt.path, applyPath);
        assert.equal(attempt.organizationId, "org-1");
        assert.equal(attempt.revision, 7);
        assert.equal(attempt.requestSha256, digest(snapshot));
        assert.ok(
          attempt.forwardedAt - attempt.delayStartedAt >= 30,
          "the delay must precede the actual forward",
        );
        assert.equal(Number.isFinite(attempt.upstreamCompletedAt), true);
        assert.equal((await state()).active, 0);
      },
      {
        delayMs: 30,
        reply: async ({ res }) => {
          res
            .writeHead(409, {
              "content-type": "application/json; charset=utf-8",
              "content-encoding": "gzip",
              "content-length": String(replyBody.length),
              "x-fixture-response": "kept",
              "set-cookie": ["fixture_one=1", "fixture_two=2"],
            })
            .end(replyBody);
        },
      },
    );
  },
);

for (const path of [
  "/rpc/agent-acp/settle-agent",
  "/rpc/agent-acp/get-runtime-barrier",
]) {
  test(
    `${path} is forwarded without the publication delay`,
    { timeout: 10000 },
    async () => {
      await withProxy(async ({ open, received, waitState }) => {
        // This is only a failure deadline: the configured 2s delay must not apply.
        const response = await within(
          open(path).done,
          "non-publication RPC",
          1000,
        );
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, acknowledgement);
        assert.equal(received.length, 1);
        assert.deepEqual(received[0].body, snapshot);
        const status = await waitState(
          (value) => value.active === 0,
          "RPC completion",
        );
        assert.equal(status.attempts.length, 1);
        assert.equal(status.attempts[0].path, path);
        assert.equal(status.attempts[0].delayStartedAt, null);
        assertTerminal(status.attempts[0], false);
      });
    },
  );
}

for (const form of ["absolute-form", "scheme-relative"]) {
  test(
    `${form} request targets cannot override the fixed upstream`,
    { timeout: 10000 },
    async () => {
      let foreignRequests = 0;
      const foreign = createServer((req, res) => {
        foreignRequests += 1;
        req.on("error", () => {});
        req.resume();
        res.writeHead(200).end("foreign upstream");
      });
      try {
        foreign.listen(0, "127.0.0.1");
        await once(foreign, "listening");
        const authority = `127.0.0.1:${foreign.address().port}`;
        const target = `${form === "absolute-form" ? "http:" : ""}//${authority}/escaped`;
        await withProxy(
          async ({ open, received, waitState }) => {
            const response = await within(
              open(target, {
                headers: {
                  "antnest-service-authorization":
                    "Bearer fixture-only-credential",
                },
              }).done,
              "fixed-upstream request",
            );
            assert.equal(response.complete, true);
            assert.equal(
              foreignRequests,
              0,
              "request target must not receive the original credentials or body",
            );
            assert.ok(
              response.status === 400 || response.status === 200,
              "the target may be rejected or sent only to the configured upstream",
            );
            if (response.status === 400) assert.equal(received.length, 0);
            else {
              assert.equal(received.length, 1);
              assert.deepEqual(received[0].body, snapshot);
              assert.deepEqual(response.body, acknowledgement);
            }
            const status = await waitState(
              (value) => value.active === 0,
              "fixed-upstream completion",
            );
            for (const attempt of status.attempts)
              assertTerminal(attempt, false);
          },
          { delayMs: 30 },
        );
      } finally {
        foreign.closeAllConnections();
        if (foreign.listening)
          await new Promise((resolve) => foreign.close(resolve));
      }
    },
  );
}

test(
  "downstream cancellation during the delay never forwards and leaves a joined terminal attempt",
  { timeout: 10000 },
  async () => {
    await withProxy(async ({ open, received, waitState, proxy }) => {
      const call = open(applyPath);
      const waiting = await waitState(
        (value) =>
          Number.isFinite(value.attempts[0]?.delayStartedAt) &&
          value.active === 1,
        "publication delay",
      );
      assert.equal(waiting.attempts[0].forwardedAt, null);
      call.destroy();
      await within(call.done, "cancelled downstream request");
      const status = await waitState(
        (value) =>
          value.active === 0 && Number.isFinite(value.attempts[0]?.completedAt),
        "cancelled delay completion",
      );
      assert.deepEqual(received, []);
      assert.equal(status.attempts.length, 1);
      assert.equal(status.attempts[0].forwardedAt, null);
      assert.equal(status.attempts[0].upstreamCompletedAt, null);
      assertTerminal(status.attempts[0], true);
      assertTerminal(proxy.attempts[0], true);
    });
  },
);

for (const boundary of ["downstream cancellation", "proxy close"]) {
  test(
    `${boundary} closes and joins the real upstream held response body`,
    { timeout: 10000 },
    async () => {
      const entered = deferred();
      const release = deferred();
      const upstreamClosed = deferred();
      let socketClosed = false;
      await withProxy(
        async ({ open, proxy, state, waitState, closeProxy, releases }) => {
          releases.push(() => release.resolve());
          const call = open(applyPath);
          await within(entered.promise, "upstream response body");
          assert.equal((await state()).active, 1);
          if (boundary === "downstream cancellation") {
            call.destroy();
            await within(upstreamClosed.promise, "cancelled upstream socket");
            await within(call.done, "cancelled downstream body");
            const status = await waitState(
              (value) => value.active === 0,
              "cancelled upstream join",
            );
            assertTerminal(status.attempts[0], true);
          }
          await within(closeProxy(), "proxy close and upstream join");
          await within(
            upstreamClosed.promise,
            "actual upstream response close",
          );
          assert.equal(socketClosed, true);
          await within(call.done, "closed downstream response");
          assert.equal(proxy.attempts.length, 1);
          assertTerminal(proxy.attempts[0], true);
          assert.equal(proxy.attempts[0].upstreamCompletedAt, null);
          release.resolve();
        },
        {
          delayMs: 30,
          reply: async ({ res }) => {
            res.once("close", () => {
              socketClosed = true;
              upstreamClosed.resolve();
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"organization_id":"org-1",');
            entered.resolve();
            await release.promise;
            if (!res.destroyed) res.end('"applied_revision":7}');
          },
        },
      );
    },
  );
}

for (const entry of [
  { name: "malformed JSON", body: Buffer.from("{not-json") },
  { name: "empty body", body: Buffer.alloc(0) },
  { name: "missing metadata", body: Buffer.from('{"agents":[]}') },
  { name: "null Agent metadata", body: Buffer.from('{"agents":[null]}') },
]) {
  test(
    `${entry.name} remains an opaque forwarded request instead of a synthesized business response`,
    { timeout: 10000 },
    async () => {
      const replyBody = Buffer.from("fixture upstream response\u0000🧪");
      await withProxy(
        async ({ open, received, waitState }) => {
          const response = await within(
            open(applyPath, { body: entry.body }).done,
            "opaque publication response",
          );
          assert.equal(response.status, 503);
          assert.equal(response.headers["x-fixture-response"], "opaque");
          assert.deepEqual(response.body, replyBody);
          assert.equal(received.length, 1);
          assert.deepEqual(received[0].body, entry.body);
          const status = await waitState(
            (value) => value.active === 0,
            "opaque request completion",
          );
          assert.equal(status.attempts.length, 1);
          const attempt = status.attempts[0];
          assertTerminal(attempt, false);
          assert.equal(attempt.organizationId, null);
          assert.equal(attempt.revision, null);
          assert.equal(attempt.requestSha256, digest(entry.body));
          assert.ok(attempt.forwardedAt - attempt.delayStartedAt >= 30);
        },
        {
          delayMs: 30,
          reply: async ({ res }) =>
            res
              .writeHead(503, {
                "content-type": "application/octet-stream",
                "x-fixture-response": "opaque",
              })
              .end(replyBody),
        },
      );
    },
  );
}
