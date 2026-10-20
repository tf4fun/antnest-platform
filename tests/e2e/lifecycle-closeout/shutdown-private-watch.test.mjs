import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { serviceClient } from "../../support/service-grants.mjs";
const { createPrivateACPTelemetry } =
  await import("../identity-closeout/private-acp-telemetry.mjs");
const url = new URL("./shutdown-private-watch.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const path = "/rpc/agent-acp/watch-agent-execution-state";
const principal = { organization_id: "organization", user_id: "owner" };
const state = {
  agent_id: "agent",
  access_allowed: true,
  configuration_revision: "a".repeat(64),
  availability: "ready",
  active_session_id: null,
  unavailable_reason: null,
};
const terminal = {
  code: "execution_state_unavailable",
  message: "Agent execution state is unavailable",
  retryable: true,
};
const frame = (event, value) =>
  `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
function contains(error, original) {
  return (
    error === original ||
    (error instanceof AggregateError &&
      error.errors.some((e) => contains(e, original)))
  );
}
async function fixture(t, options = {}) {
  assert.equal(typeof implementation.openShutdownPrivateWatch, "function");
  const requests = [],
    exports = [],
    archives = [],
    clients = [],
    handlerErrors = [];
  const parent = new AbortController();
  let reply;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === "/v1/traces") {
        exports.push(body);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("{}");
        return;
      }
      requests.push({
        path: request.url,
        method: request.method,
        headers: request.headers,
        body,
      });
      if (request.url === "/rpc/identity/resolve-access-token") {
        assert.equal(
          request.headers["antnest-service-authorization"],
          `Bearer ${"G".repeat(43)}`,
        );
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            caller_context: "original-issued-context",
            principal: options.foreign
              ? { ...principal, user_id: "other" }
              : principal,
          }),
        );
        return;
      }
      assert.equal(request.url, path);
      assert.equal(request.method, "POST");
      assert.deepEqual(body, {});
      assert.equal(request.headers.cookie, undefined);
      assert.equal(
        request.headers["antnest-caller-context"],
        "original-issued-context",
      );
      assert.equal(
        request.headers["antnest-service-authorization"],
        `Bearer ${"W".repeat(43)}`,
      );
      assert.match(
        request.headers.traceparent,
        /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u,
      );
      reply = response;
      response.writeHead(options.status ?? 200, {
        "content-type": options.contentType ?? "text/event-stream",
      });
      const text =
        options.body ??
        frame("workspace_state", {
          ...state,
          agent_id: options.agentId ?? "agent",
        });
      if (options.fragment) {
        const bytes = Buffer.from(text),
          split = bytes.indexOf(Buffer.from("雪")) + 1;
        assert(split > 0);
        response.write(bytes.subarray(0, split));
        await delay(30);
        response.write(bytes.subarray(split));
      } else response.write(text);
      if (options.end) response.end();
    })().catch((error) => {
      handlerErrors.push(error);
      response.destroy(error);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const telemetry = createPrivateACPTelemetry(origin + "/v1/traces");
  const service = serviceClient({
    identityEndpoint: origin,
    readCredential: (grant) =>
      (grant === "gateway-identity" ? "G" : "W").repeat(43),
  });
  t.after(async () => {
    for (const client of clients) await client.closeAndWait().catch(() => {});
    parent.abort();
    await telemetry.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(handlerErrors, []);
  });
  return {
    requests,
    exports,
    archives,
    parent,
    telemetry,
    async open() {
      const client = await implementation.openShutdownPrivateWatch(
        options.agentId ?? "agent",
        { accessToken: "original-login-session" },
        {
          principal: options.principal ?? principal,
          service,
          telemetry,
          endpoint: origin + path,
          signal: parent.signal,
          secrets: [],
          preserve: (value) => archives.push(structuredClone(value)),
        },
      );
      clients.push(client);
      return client;
    },
    end: (value) => reply.end(value ?? ""),
    reset: () => reply.destroy(),
  };
}
test("Shutdown private state uses the original login, full split UTF-8 frames and an actual CLIENT across the 12-second request budget", async (t) => {
  const f = await fixture(t, { agentId: "agent-雪", fragment: true });
  const watch = await f.open();
  await watch.ready();
  watch.assertOpen();
  await delay(12300);
  watch.assertOpen();
  assert.equal(f.requests.filter((r) => r.path === path).length, 1);
  assert.equal(f.requests[0].body.access_token, "original-login-session");
  assert.equal(f.requests[0].body.profile, "workspace");
  const before = Date.now();
  f.end(frame("workspace_error", terminal));
  await watch.waitClosed();
  const closure = watch.closure;
  assert.equal(closure.kind, "transport-end");
  assert(closure.observedAt >= before && closure.observedAt <= Date.now());
  assert(Object.isFrozen(closure));
  const snapshot = await watch.closeAndWait();
  assert.equal(watch.closure, closure);
  assert.equal(snapshot.joined, true);
  assert.deepEqual(snapshot.events, [{ ...state, agent_id: "agent-雪" }]);
  assert.deepEqual(snapshot.terminal_events, [terminal]);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body_outcome, "eof");
  assert(
    Buffer.from(snapshot.raw_body_base64, "base64")
      .toString()
      .includes("agent-雪"),
  );
  await f.telemetry.flush();
  const spans = f.exports
    .flatMap((r) => r.resourceSpans ?? [])
    .flatMap((r) => r.scopeSpans ?? [])
    .flatMap((r) => r.spans ?? []);
  const client = spans.find((s) => s.spanId === snapshot.clientSpanID);
  assert(client, "actual HTTP CLIENT was not exported");
  assert.equal(client.traceId, snapshot.traceID);
  assert.equal(client.kind, 3);
  assert(f.archives.at(-1).joined);
  assert.equal(await watch.waitClosed(), closure);
});
test("Shutdown private state rejects a foreign Principal before opening the watch", async (t) => {
  const f = await fixture(t, { foreign: true });
  await assert.rejects(f.open(), /authority/u);
  assert.equal(f.requests.filter((r) => r.path === path).length, 0);
});

test("Shutdown received state cannot be rewritten through the ready result", async (t) => {
  const f = await fixture(t),
    watch = await f.open();
  const received = await watch.ready();
  received.agent_id = "foreign";
  assert.deepEqual(watch.events, [state]);
  assert.deepEqual(await watch.ready(), state);
  await watch.closeAndWait();
  assert.deepEqual(f.archives.at(-1).events, [state]);
});
test("Shutdown authority snapshot cannot change when the caller mutates its Principal", async (t) => {
  const original = { ...principal },
    f = await fixture(t, { principal: original });
  const watch = await f.open();
  await watch.ready();
  original.user_id = "foreign";
  assert.deepEqual(watch.snapshot().principal, principal);
  await watch.closeAndWait();
  assert.deepEqual(f.archives.at(-1).principal, principal);
});
for (const [name, body] of [
  [
    "missing complete state field",
    frame("workspace_state", { ...state, configuration_revision: undefined }),
  ],
  [
    "foreign Agent",
    frame("workspace_state", { ...state, agent_id: "another" }),
  ],
  ["invalid JSON", "event: workspace_state\ndata: private-invalid-json\n\n"],
  ["replay cursor", "id: 5\n" + frame("workspace_state", state)],
  ["error without a first state", frame("workspace_error", terminal)],
  ["unexpected event", frame("another_event", state)],
])
  test(`Shutdown private watch rejects ${name} and retains its actual partial body`, async (t) => {
    const f = await fixture(t, { body, end: true });
    const watch = await f.open();
    await assert.rejects(watch.ready());
    await assert.rejects(watch.closeAndWait());
    const snapshot = watch.snapshot();
    assert.equal(
      Buffer.from(snapshot.raw_body_base64, "base64").toString(),
      body,
    );
    assert.notEqual(snapshot.closure.kind, "transport-end");
  });
for (const bad of [{ status: 503 }, { contentType: "application/json" }])
  test(`Shutdown private watch rejects response ${JSON.stringify(bad)} while retaining status and body`, async (t) => {
    const f = await fixture(t, {
      ...bad,
      body: JSON.stringify(terminal),
      end: true,
    });
    const watch = await f.open();
    await assert.rejects(watch.ready());
    await assert.rejects(watch.closeAndWait());
    assert.equal(watch.snapshot().status, bad.status ?? 200);
    assert.equal(
      Buffer.from(watch.snapshot().raw_body_base64, "base64").toString(),
      JSON.stringify(terminal),
    );
  });
for (const kind of ["local-close", "global-abort"])
  test(`Shutdown private ${kind} cannot become a remote closure`, async (t) => {
    const f = await fixture(t),
      watch = await f.open();
    await watch.ready();
    const reason = new Error("original parent cancellation");
    if (kind === "local-close") await watch.closeAndWait();
    else {
      f.parent.abort(reason);
      await assert.rejects(watch.closeAndWait(), (e) => contains(e, reason));
    }
    await assert.rejects(watch.waitClosed());
    assert.equal(watch.closure.kind, kind);
  });
test("Shutdown private HTTP reset retains the original read failure and cannot become EOF", async (t) => {
  const f = await fixture(t),
    watch = await f.open();
  await watch.ready();
  f.reset();
  let original;
  await assert.rejects(watch.waitClosed(), (e) => {
    original = e;
    return true;
  });
  await assert.rejects(watch.closeAndWait(), (e) => e === original);
  assert.equal(watch.closure.kind, "transport-error");
});
test("Shutdown private reader, archive and cancellation failures are joined and retain their original objects", async () => {
  assert.equal(typeof implementation.openShutdownPrivateWatch, "function");
  const readError = new Error("original read"),
    cancelError = new Error("original cancel"),
    archiveError = new Error("original archive");
  let reads = 0,
    released = false,
    ended = false,
    snapshot;
  const watch = await implementation.openShutdownPrivateWatch(
    "agent",
    { accessToken: "original-session" },
    {
      principal,
      secrets: [],
      endpoint: "http://127.0.0.1:12345" + path,
      service: {
        workspaceContext: async () => ({ context: "issued", principal }),
        authorization: () => ({ "Antnest-Service-Authorization": "Bearer W" }),
      },
      telemetry: {
        startHTTP: () => ({
          traceID: "a".repeat(32),
          clientSpanID: "b".repeat(16),
          traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
          end: () => {
            ended = true;
          },
        }),
      },
      fetchImpl: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: {
          getReader: () => ({
            async read() {
              if (reads++ === 0)
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    frame("workspace_state", state),
                  ),
                };
              throw readError;
            },
            async cancel() {
              throw cancelError;
            },
            releaseLock() {
              released = true;
            },
          }),
        },
      }),
      preserve: (value) => {
        snapshot = value;
        throw archiveError;
      },
    },
  );
  await watch.ready();
  await assert.rejects(watch.waitClosed(), (e) =>
    [readError, cancelError, archiveError].every((original) =>
      contains(e, original),
    ),
  );
  await assert.rejects(watch.closeAndWait(), (e) =>
    [readError, cancelError, archiveError].every((original) =>
      contains(e, original),
    ),
  );
  assert(released && ended && snapshot.joined);
});

for (const phase of ["read", "cancel"])
  test(`Shutdown local close retains an independent ${phase} AbortError object`, async () => {
    const original = new DOMException(
      "independent cleanup failure",
      "AbortError",
    );
    let reads = 0,
      requestSignal;
    const pending = Promise.withResolvers();
    void pending.promise.catch(() => {});
    const watch = await implementation.openShutdownPrivateWatch(
      "agent",
      { accessToken: "original-session" },
      {
        principal,
        secrets: [],
        endpoint: "http://127.0.0.1:12345" + path,
        service: {
          workspaceContext: async () => ({ context: "issued", principal }),
          authorization: () => ({
            "Antnest-Service-Authorization": "Bearer W",
          }),
        },
        telemetry: {
          startHTTP: () => ({
            traceID: "a".repeat(32),
            clientSpanID: "b".repeat(16),
            traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
            end() {},
          }),
        },
        fetchImpl: async (url, init) => {
          requestSignal = init.signal;
          requestSignal.addEventListener(
            "abort",
            () =>
              pending.reject(
                phase === "read" ? original : requestSignal.reason,
              ),
            { once: true },
          );
          return {
            status: 200,
            headers: new Headers({ "content-type": "text/event-stream" }),
            body: {
              getReader: () => ({
                async read() {
                  if (reads++ === 0)
                    return {
                      done: false,
                      value: new TextEncoder().encode(
                        frame("workspace_state", state),
                      ),
                    };
                  return pending.promise;
                },
                async cancel() {
                  if (phase === "cancel") throw original;
                },
                releaseLock() {},
              }),
            },
          };
        },
        preserve() {},
      },
    );
    await watch.ready();
    await assert.rejects(watch.closeAndWait(), (error) =>
      contains(error, original),
    );
    assert.equal(watch.closure.kind, "local-close");
    assert(watch.snapshot().joined);
  });
