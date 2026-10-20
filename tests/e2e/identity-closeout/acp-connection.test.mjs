import assert from "node:assert/strict";
import test from "node:test";
import { privateTransportFixture } from "./private-acp-transport.fixture.mjs";

test("private local cleanup terminates a stalled handshake and joins the actual socket close", async (t) => {
  const f = await privateTransportFixture(t);
  const client = f.connect(2);
  await client.initialize();
  for (const peer of f.sockets.clients) peer._socket.pause();
  assert.equal(typeof client.closeAndWait, "function");
  const closed = await client.closeAndWait({ graceMs: 30 });
  assert.equal(closed.code, 1006);
  assert.equal(closed.localClose, true);
  assert.equal(await client.waitForClose(50), closed);
  await assert.rejects(() => client.request("list", {}));
});

for (const version of [1, 2])
  test(`private v${version} uses the official SDK with workload/CCT headers and an exported CLIENT`, async (t) => {
    const f = await privateTransportFixture(t);
    const client = f.connect(version);
    assert.equal(client.boundary, "private-acp");
    assert.equal(client.observedConnectionTraceID, undefined);
    await client.initialize();
    assert.equal(
      (await client.request("new", { cwd: "/workspace", mcpServers: [] }))
        .sessionId,
      "session",
    );
    assert.equal(
      (await client.request("list", {})).sessions[0].sessionId,
      "session",
    );
    assert.deepEqual(
      client.requests.map((request) => request.method),
      ["initialize", "session/new", "session/list"],
    );
    const upgrade = f.upgrades[0];
    assert.equal(upgrade.path, `/v${version}/acp`);
    assert.equal(upgrade.headers["antnest-caller-context"], f.context);
    assert.equal(
      upgrade.headers["antnest-service-authorization"],
      f.authorization["Antnest-Service-Authorization"],
    );
    assert.equal(upgrade.headers.cookie, undefined);
    assert.equal(upgrade.headers.origin, undefined);
    assert.equal(
      upgrade.headers.traceparent,
      `00-${client.connectionTraceID}-${client.clientSpanID}-01`,
    );
    assert.equal(
      client.observedConnectionTraceID,
      undefined,
      "private response header is not an observed server trace",
    );
    assert.notEqual(client.connectionTraceID, "f".repeat(32));
    assert.equal(
      client.connectionSpanID,
      undefined,
      "server span must come from collected raw",
    );
    assert(f.messages.every((message) => message.params?._meta === undefined));
    const spans = await f.exportedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].traceId, client.connectionTraceID);
    assert.equal(spans[0].spanId, client.clientSpanID);
    assert(!JSON.stringify(f.exports).includes(f.context));
    assert(
      !JSON.stringify(f.exports).includes(
        f.authorization["Antnest-Service-Authorization"],
      ),
    );
    client.close();
    assert.equal((await client.waitForClose(2000)).localClose, true);
    const count = client.requests.length;
    await assert.rejects(() => client.request("list", {}));
    assert.equal(client.requests.length, count);
  });

test("private ACP rejects incomplete configuration and authentication overrides before connecting", async (t) => {
  const f = await privateTransportFixture(t);
  for (const mutate of [
    (options) => delete options.context,
    (options) => {
      options.context = "";
    },
    (options) => {
      options.context = "secret\r\nCookie: forged";
    },
    (options) => delete options.authorization,
    (options) => {
      options.authorization = {
        "Antnest-Service-Authorization": "Bearer invalid",
      };
    },
    (options) => {
      options.authorization.Cookie = "forged";
    },
    (options) => delete options.telemetry,
    (options) => delete options.endpoint,
    (options) => {
      options.headers = { Cookie: "forged" };
    },
    (options) => {
      options.headers = { "antnest-caller-context": "forged" };
    },
    (options) => {
      options.injectTraceParent = false;
    },
    (options) => {
      options.endpoint = `${f.origin}/api/app/agents/agent/v1/acp`;
    },
    (options) => {
      options.endpoint = `${f.origin}/v2/acp`;
    },
    (options) => {
      options.endpoint = `${f.origin}/v1/acp?token=secret`;
    },
    (options) => {
      options.endpoint = `${f.origin}/v1/acp#fragment`;
    },
    (options) => {
      options.endpoint = "ws://user:secret@127.0.0.1/v1/acp";
    },
    (options) => {
      options.endpoint = "file:///v1/acp";
    },
  ]) {
    const options = { ...f.options(1), authorization: { ...f.authorization } };
    mutate(options);
    assert.throws(() => f.connect(1, options));
  }
  assert.throws(() => f.connect(1, f.options(1), "browser-cookie"));
  for (const boundary of [null, false, "", "unknown"])
    assert.throws(() => f.connect(1, { ...f.options(1), boundary }));
  for (const version of [0, 3, "1"])
    assert.throws(() => f.connect(version, f.options(1)));
  assert.equal(f.upgrades.length, 0);
  assert.equal((await f.exportedSpans()).length, 0);
});

test("a private rejected upgrade exports failure and sends no ACP messages", async (t) => {
  const f = await privateTransportFixture(t, { deny: true });
  const client = f.connect(1);
  assert.equal(client.boundary, "private-acp");
  await assert.rejects(
    () => client.initialize(),
    (error) => error.status === 401,
  );
  await client.waitForClose(2000);
  assert.equal(f.messages.length, 0);
  const spans = await f.exportedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status.code, 2);
  const status = spans[0].attributes.find(
    ({ key }) => key === "http.response.status_code",
  );
  assert.equal(Number(status.value.intValue), 401);
});

test("private remote close remains distinguishable from local cleanup", async (t) => {
  const f = await privateTransportFixture(t);
  const client = f.connect(2);
  assert.equal(client.boundary, "private-acp");
  await client.initialize();
  const count = client.requests.length;
  for (const socket of f.sockets.clients)
    socket.close(1008, "caller_context_expired");
  const closed = await client.waitForClose(2000);
  assert.equal(closed.localClose, false);
  assert.equal(closed.code, 1008);
  assert.equal(closed.reason, "caller_context_expired");
  await assert.rejects(() => client.request("list", {}));
  assert.equal(client.requests.length, count);
});

test("HTTP 101 with an invalid WebSocket handshake remains an exported CLIENT failure", async (t) => {
  const f = await privateTransportFixture(t, { badAccept: true });
  const client = f.connect(1);
  await assert.rejects(() => client.initialize(), /Sec-WebSocket-Accept/u);
  await client.waitForClose(2000);
  assert.equal(f.messages.length, 0);
  const spans = await f.exportedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status.code, 2);
  const status = spans[0].attributes.find(
    ({ key }) => key === "http.response.status_code",
  );
  assert.equal(
    Number(status.value.intValue),
    101,
    "retain the actual rejected handshake response",
  );
});
