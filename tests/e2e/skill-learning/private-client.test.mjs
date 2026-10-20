import assert from "node:assert/strict";
import test from "node:test";
import { privateTransportFixture } from "../identity-closeout/private-acp-transport.fixture.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";

const url = new URL("./private-client.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const { openBrowserPrivateACP } =
  await import("../identity-closeout/private-acp-browser.mjs");

test("Skill private client preserves original authority, notice negotiation and dynamic SDK state", async (t) => {
  assert.equal(typeof implementation.createSkillACPConnector, "function");
  const f = await privateTransportFixture(t);
  const principal = { organization_id: "organization", user_id: "owner" };
  const browser = new GatewayClient(f.origin);
  browser.cookies.set("antnest_session", "original-skill-session");
  const resolutions = [];
  const secrets = [];
  const service = {
    async workspaceContext(token, agent) {
      resolutions.push({ token, agent });
      return { principal, context: f.context };
    },
    authorization(grant) {
      assert.equal(grant, "agent-ui-acp");
      return f.authorization;
    },
  };
  let original;
  const open = implementation.createSkillACPConnector({
    createTelemetry: () => f.telemetry,
    async open(...args) {
      original = await openBrowserPrivateACP(...args);
      return original;
    },
  });
  const client = await open(1, "agent", browser, {
    principal,
    service,
    secrets,
    endpoint: `${f.origin}/v1/acp`,
    clientCapabilities: { session: { notices: {} } },
  });
  assert.strictEqual(client, original);
  assert.deepEqual(resolutions, [
    { token: "original-skill-session", agent: "agent" },
  ]);
  assert.equal(f.upgrades[0].headers.cookie, undefined);
  assert.equal(f.upgrades[0].headers["antnest-caller-context"], f.context);
  assert.deepEqual(
    f.messages.map((message) => message.method),
    ["initialize"],
  );
  assert.deepEqual(f.messages[0].params.clientCapabilities, {
    session: { notices: {} },
  });
  assert.equal(client.closeCode, undefined);
  const result = await implementation.withSkillACPClient(client, () =>
    client.request("new", { cwd: "/workspace", mcpServers: [] }),
  );
  assert.equal(result.sessionId, "session");
  assert.equal(typeof client.closeCode, "number");
  assert.deepEqual(
    f.messages.map((message) => message.method),
    ["initialize", "session/new"],
  );
  assert.equal(f.exports.length, 1);
  assert(secrets.includes("original-skill-session"));
});

test("Skill private close joins transport, flush and shutdown exactly once even when all fail", async () => {
  assert.equal(typeof implementation.createSkillACPConnector, "function");
  const order = [];
  const errors = [
    new Error("close"),
    new Error("flush"),
    new Error("shutdown"),
  ];
  const client = {
    async closeAndWait() {
      order.push("close");
      throw errors[0];
    },
  };
  const open = implementation.createSkillACPConnector({
    open: async () => client,
    createTelemetry: () => ({
      async flush() {
        order.push("flush");
        throw errors[1];
      },
      async shutdown() {
        order.push("shutdown");
        throw errors[2];
      },
    }),
  });
  const returned = await open(1, "agent", {}, {});
  assert.strictEqual(returned, client);
  const closing = client.closeAndWait();
  assert.strictEqual(client.closeAndWait(), closing);
  await assert.rejects(closing, (error) => {
    assert.deepEqual(error.errors, errors);
    return true;
  });
  assert.deepEqual(order, ["close", "flush", "shutdown"]);
});

test("Skill private opening failure still flushes and shuts down while retaining every error", async () => {
  assert.equal(typeof implementation.createSkillACPConnector, "function");
  const order = [];
  const errors = [
    new Error("initialize and close"),
    new Error("flush"),
    new Error("shutdown"),
  ];
  const open = implementation.createSkillACPConnector({
    async open() {
      order.push("open");
      throw errors[0];
    },
    createTelemetry: () => ({
      async flush() {
        order.push("flush");
        throw errors[1];
      },
      async shutdown() {
        order.push("shutdown");
        throw errors[2];
      },
    }),
  });
  await assert.rejects(
    () => open(1, "agent", {}, {}),
    (error) => {
      assert.deepEqual(error.errors, errors);
      return true;
    },
  );
  assert.deepEqual(order, ["open", "flush", "shutdown"]);
});

test("Skill business and joined cleanup failures remain separately inspectable", async () => {
  assert.equal(typeof implementation.withSkillACPClient, "function");
  const business = new Error("business failure"),
    cleanup = new Error("cleanup failure");
  let closed = 0;
  await assert.rejects(
    () =>
      implementation.withSkillACPClient(
        {
          async closeAndWait() {
            closed++;
            throw cleanup;
          },
        },
        () => {
          throw business;
        },
      ),
    (error) => {
      assert.deepEqual(error.errors, [business, cleanup]);
      return true;
    },
  );
  assert.equal(closed, 1);
  await assert.rejects(
    () =>
      implementation.withSkillACPClient(
        {
          async closeAndWait() {
            closed++;
          },
        },
        () => {
          throw business;
        },
      ),
    (error) => error === business,
  );
  assert.equal(closed, 2);
});
