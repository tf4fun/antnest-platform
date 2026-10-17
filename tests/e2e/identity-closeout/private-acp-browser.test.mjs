import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { privateTransportFixture } from "./private-acp-transport.fixture.mjs";
import { GatewayClient } from "./support.mjs";
import { serviceClient } from "../../support/service-grants.mjs";

const url = new URL("./private-acp-browser.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const principal = { organization_id: "organization", user_id: "user" };

async function fixture(t, override = {}) {
  const transport = await privateTransportFixture(t, {
    deny: override.deny,
    initializeError: override.initializeError,
    initializationResult: override.initializationResult,
  });
  const requests = [];
  const identity = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      path: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    override.beforeReply?.();
    response.writeHead(override.status ?? 200, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        override.status
          ? { code: "unauthenticated" }
          : {
              caller_context: transport.context,
              principal: override.principal ?? principal,
            },
      ),
    );
  });
  await new Promise((resolve) => identity.listen(0, "127.0.0.1", resolve));
  const clients = [];
  t.after(async () => {
    for (const client of clients) {
      client.close();
      await client.waitForClose(2000);
    }
    identity.closeAllConnections();
    await new Promise((resolve) => identity.close(resolve));
  });
  const browser = new GatewayClient(transport.origin);
  browser.cookies = new Map([
    ["antnest_session", "original-browser-session"],
    ["antnest_csrf", "original-browser-csrf"],
  ]);
  const secrets = [];
  const service = serviceClient({
    identityEndpoint: `http://127.0.0.1:${identity.address().port}`,
    readCredential: (grant) =>
      grant === "gateway-identity" ? "G".repeat(43) : "W".repeat(43),
  });
  return {
    ...transport,
    requests,
    secrets,
    async open(version, signal) {
      assert.equal(typeof implementation.openBrowserPrivateACP, "function");
      const client = await implementation.openBrowserPrivateACP(
        version,
        "agent",
        browser,
        {
          principal,
          service,
          telemetry: transport.telemetry,
          endpoint: `${transport.origin}/v${version}/acp`,
          secrets,
          signal,
        },
      );
      clients.push(client);
      return client;
    },
  };
}

for (const version of [1, 2])
  test(`browser v${version} delegates its existing session through Identity before the actual private SDK upgrade`, async (t) => {
    const f = await fixture(t);
    const client = await f.open(version);
    assert.equal(
      (await client.request("new", { cwd: "/workspace", mcpServers: [] }))
        .sessionId,
      "session",
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].path, "/rpc/identity/resolve-access-token");
    assert.deepEqual(f.requests[0].body, {
      access_token: "original-browser-session",
      profile: "workspace",
      agent_id: "agent",
    });
    assert.equal(f.requests[0].headers.cookie, undefined);
    assert.equal(
      f.requests[0].headers["antnest-service-authorization"],
      `Bearer ${"G".repeat(43)}`,
    );
    assert.equal(f.upgrades.length, 1);
    assert.equal(f.upgrades[0].path, `/v${version}/acp`);
    assert.equal(f.upgrades[0].headers.cookie, undefined);
    assert.equal(f.upgrades[0].headers["antnest-caller-context"], f.context);
    assert.equal(
      f.upgrades[0].headers["antnest-service-authorization"],
      `Bearer ${"W".repeat(43)}`,
    );
    assert(f.secrets.includes(f.context));
    assert(f.secrets.includes("original-browser-session"));
    assert(f.secrets.includes("W".repeat(43)));
    assert.equal((await f.exportedSpans()).length, 1);
  });

for (const version of [1, 2])
  test(`browser v${version} retains the single actual SDK initialize result through requests and cleanup`, async (t) => {
    const initializationResult =
      version === 1
        ? {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: {
                image: true,
                audio: true,
                embeddedContext: true,
              },
            },
            agentInfo: { name: "browser-negotiation-peer", version: "41" },
            authMethods: [],
            _meta: { negotiation: "browser-v1" },
          }
        : {
            protocolVersion: 2,
            info: { name: "browser-negotiation-peer", version: "42" },
            capabilities: {
              session: {
                prompt: { image: {}, audio: {}, embeddedContext: {} },
              },
            },
            _meta: { negotiation: "browser-v2" },
          };
    const f = await fixture(t, { initializationResult });
    const client = await f.open(version);
    assert.deepEqual(client.initializationResult, initializationResult);
    const retained = client.initializationResult;
    await client.request("new", { cwd: "/workspace", mcpServers: [] });
    await client.closeAndWait();
    assert.strictEqual(client.initializationResult, retained);
    assert.deepEqual(client.initializationResult, initializationResult);
    assert.deepEqual(
      f.messages.map((message) => message.method),
      ["initialize", "session/new"],
    );
  });

for (const field of ["organization_id", "user_id"])
  test(`a foreign resolved ${field} cannot open a private connection`, async (t) => {
    const f = await fixture(t, {
      principal: { ...principal, [field]: "PRIVATE-FOREIGN-PRINCIPAL" },
    });
    await assert.rejects(
      () => f.open(1),
      (error) => {
        assert.match(error.message, /workspace authority changed/);
        assert(!String(error).includes("PRIVATE-FOREIGN-PRINCIPAL"));
        assert(!String(error).includes(f.context));
        return true;
      },
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.upgrades.length, 0);
  });

test("an Identity rejection never attempts a private SDK connection", async (t) => {
  const f = await fixture(t, { status: 401 });
  await assert.rejects(() => f.open(1));
  assert.equal(f.requests.length, 1);
  assert.equal(f.upgrades.length, 0);
});

test("cancellation during Identity resolution is preserved before any private upgrade", async (t) => {
  const controller = new AbortController();
  const reason = new Error("cancelled while resolving browser authority");
  const f = await fixture(t, { beforeReply: () => controller.abort(reason) });
  await assert.rejects(
    () => f.open(2, controller.signal),
    (error) => error === reason,
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.upgrades.length, 0);
});

test("a rejected SDK initialize is joined before the browser connector fails", async (t) => {
  const f = await fixture(t, { deny: true });
  await assert.rejects(
    () => f.open(1),
    (error) => error.status === 401,
  );
  assert.equal(f.upgrades.length, 1);
  assert.equal(f.messages.length, 0);
  assert.equal(f.sockets.clients.size, 0);
});

test(
  "a successful upgrade with refused initialization retains its error after a stalled close handshake",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { initializeError: true });
    await assert.rejects(
      () => f.open(2),
      (error) => {
        assert.equal(error.code, -32603);
        assert.match(error.message, /fixture initialize refused/);
        return true;
      },
    );
    assert.equal(f.upgrades.length, 1);
    assert.equal(f.messages.length, 1);
  },
);
