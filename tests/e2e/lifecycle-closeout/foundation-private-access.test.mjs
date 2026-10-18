import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foundationConnectionFixture,
  principal,
  setup,
} from "./foundation-connection.fixture.mjs";
const url = new URL("./foundation-private-access.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function fixture(t, options = {}) {
  assert.equal(typeof implementation.createFoundationPrivateAccess, "function");
  const f = await foundationConnectionFixture(t),
    connections = [],
    states = [];
  const credentials = await mkdtemp(join(tmpdir(), "foundation-access-"));
  t.after(() => rm(credentials, { recursive: true, force: true }));
  for (const [path, value] of [
    ["edge-gateway/tokens/identity-service", "G"],
    ["agent-ui/tokens/agent-acp-service", "W"],
  ]) {
    await mkdir(join(credentials, path, ".."), { recursive: true });
    await writeFile(join(credentials, path), value.repeat(43), { mode: 0o600 });
  }
  const access = await implementation.createFoundationPrivateAccess(
    {
      jaeger: f.origin,
      evidence: credentials,
      privateAccess: {
        acp: f.origin,
        identity: f.origin,
        otlp: f.origin + "/v1/traces",
        credentials,
      },
    },
    {
      secrets: [],
      preserveConnection: (index, snapshot) =>
        connections.push({ index, snapshot }),
      preserveState: (receipts) => states.push(structuredClone(receipts)),
      ...options,
    },
  );
  t.after(() => access.closeAndWait());
  return { ...f, access, connections, states };
}
test("Foundation host uses its inner two grants, original owner and full private state", async (t) => {
  const f = await fixture(t);
  const c = f.register(await f.access.open("agent", f.browser, principal));
  await c.request("new", setup);
  assert.deepEqual(
    await f.access.state("agent", f.browser, principal),
    f.state,
  );
  await f.access.closeAndWait();
  assert.equal(f.connections.at(-1).snapshot.closed, true);
  assert.equal(
    JSON.parse(f.states.at(-1)[0].rawBody).configuration_revision,
    "a".repeat(64),
  );
  assert.equal(f.states.at(-1)[0].status, 200);
  assert.equal(f.identities.length, 2);
  assert(
    f.identities.every(
      (row) =>
        row.body.access_token === f.browser.accessToken &&
        row.body.agent_id === "agent",
    ),
  );
  assert(
    f.identities.every(
      (row) =>
        row.headers["antnest-service-authorization"] ===
        `Bearer ${"G".repeat(43)}`,
    ),
  );
  assert(f.exports.length > 0);
});

test("Loss can select its own collector while retaining the original shared telemetry and request context", async (t) => {
  const calls = [];
  const f = await fixture(t, {
    async collectTrace(base, expected, options) {
      calls.push({ base, expected, options });
      await options.flush();
      return { loss: true, original: expected };
    },
  });
  const c = f.register(await f.access.open("agent", f.browser, principal));
  await c.closeAndWait();
  const expected = { lossCollectorSentinel: c.snapshot().initialization };
  const requests = [];
  const result = await f.access.collect(expected, requests);
  assert.deepEqual(result, { loss: true, original: expected });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].base, f.origin);
  assert.equal(calls[0].expected, expected);
  assert.equal(calls[0].options.requests, requests);
  assert(calls[0].options.directory.endsWith("/traces"));
  assert(Array.isArray(calls[0].options.secrets));
  assert(f.exports.length > 0);
  await f.access.closeAndWait();
  assert.equal(f.connections.at(-1).snapshot.closed, true);
});
test("Foundation retains raw state when complete configuration revision validation fails", async (t) => {
  const f = await fixture(t);
  delete f.state.configuration_revision;
  await assert.rejects(
    f.access.state("agent", f.browser, principal),
    /complete ACP execution state schema/u,
  );
  assert.equal(f.states.at(-1)[0].status, 200);
  assert.deepEqual(JSON.parse(f.states.at(-1)[0].rawBody), f.state);
});
