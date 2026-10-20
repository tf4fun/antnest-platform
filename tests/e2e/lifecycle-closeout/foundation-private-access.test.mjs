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
  t.after(async () => {
    const [closed] = await Promise.allSettled([access.closeAndWait()]);
    if (!options.allowCloseFailure && closed.status === "rejected")
      throw closed.reason;
  });
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

test("Shutdown access joins a late watch factory before closing its exporter", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const archives = [],
    secrets = [],
    abort = new AbortController();
  let captured,
    joined = 0;
  const f = await fixture(t, {
    secrets,
    signal: abort.signal,
    preserveWatch: (index, snapshot) => archives.push({ index, snapshot }),
    async watchFactory(agent, browser, options) {
      captured = { agent, browser, options };
      const operation = options.telemetry.startHTTP("POST");
      entered.resolve();
      await release.promise;
      const value = {
        agentId: agent,
        traceID: operation.traceID,
        joined: false,
      };
      return {
        snapshot: () => value,
        async closeAndWait() {
          joined++;
          operation.end(200, "cancelled", 0);
          value.joined = true;
          await options.preserve(value);
        },
      };
    },
  });
  assert.equal(typeof f.access.watch, "function");
  const opened = f.access.watch("agent", f.browser, principal);
  await entered.promise;
  let settled = false;
  const closed = f.access.closeAndWait();
  void closed.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false);
  } finally {
    release.resolve();
  }
  const watch = await opened;
  await closed;
  assert.equal(joined, 1);
  assert.equal(captured.agent, "agent");
  assert.equal(captured.browser, f.browser);
  assert.equal(captured.options.principal, principal);
  assert.equal(captured.options.signal, abort.signal);
  assert.equal(captured.options.secrets, secrets);
  assert.equal(
    captured.options.endpoint,
    f.origin + "/rpc/agent-acp/watch-agent-execution-state",
  );
  assert.equal(typeof captured.options.service.workspaceContext, "function");
  assert.equal(archives[0].index, 1);
  assert.equal(archives[0].snapshot.joined, true);
  assert(
    f.exports.length > 0,
    "late watch CLIENT did not reach its original exporter",
  );
  const snapshots = f.access.watchSnapshots();
  snapshots[0].agentId = "foreign";
  assert.equal(watch.snapshot().agentId, "agent");
  await assert.rejects(
    async () => f.access.watch("late", f.browser, principal),
    /closing/,
  );
});

test("Shutdown access retains a late factory rejection after the caller observes it", async (t) => {
  const original = new Error("late private watch construction failure");
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = await fixture(t, {
    allowCloseFailure: true,
    async watchFactory() {
      entered.resolve();
      await release.promise;
      throw original;
    },
  });
  assert.equal(typeof f.access.watch, "function");
  const opened = f.access.watch("agent", f.browser, principal);
  void opened.catch(() => {});
  await entered.promise;
  const closed = f.access.closeAndWait();
  void closed.catch(() => {});
  release.resolve();
  await assert.rejects(opened, (error) => error === original);
  await assert.rejects(closed, (error) => error === original);
});

test("Shutdown access preserves call-order watch archives and joins siblings after close and archive failures", async (t) => {
  const first = new Error("first watch close failed"),
    second = new Error("second watch archive failed");
  const release = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const archived = [],
    joined = [];
  const f = await fixture(t, {
    allowCloseFailure: true,
    preserveWatch(index, snapshot) {
      archived.push({ index, snapshot });
      if (index === 2) throw second;
    },
    async watchFactory(agent, browser, options) {
      if (agent === "first") {
        entered.resolve();
        await release.promise;
      }
      const operation = options.telemetry.startHTTP("POST");
      return {
        snapshot: () => ({ agentId: agent }),
        async closeAndWait() {
          joined.push(agent);
          operation.end(200, "cancelled");
          await options.preserve({ agentId: agent });
          if (agent === "first") throw first;
        },
      };
    },
  });
  assert.equal(typeof f.access.watch, "function");
  const one = f.access.watch("first", f.browser, principal);
  await entered.promise;
  await f.access.watch("second", f.browser, principal);
  release.resolve();
  await one;
  const client = f.register(await f.access.open("agent", f.browser, principal));
  await assert.rejects(f.access.closeAndWait(), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert(error.errors.includes(first) && error.errors.includes(second));
    return true;
  });
  assert.deepEqual(joined.toSorted(), ["first", "second"]);
  assert.deepEqual(
    archived
      .toSorted((a, b) => a.index - b.index)
      .map((x) => [x.index, x.snapshot.agentId]),
    [
      [1, "first"],
      [2, "second"],
    ],
  );
  assert.equal(client.snapshot().closed, true);
  assert(f.exports.length >= 3);
});
