import assert from "node:assert/strict";
import test from "node:test";
import { restoreTransportFixture } from "./restore-private-transport.fixture.mjs";
const url = new URL("./shutdown-private-flow.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});

function fixture(errors = {}) {
  const events = [],
    clients = [],
    watches = [];
  const principal = { organization_id: "org", user_id: "member" },
    owner = { accessToken: "original-session" };
  const login = { status: 200, traceID: "1".repeat(32), body: { principal } };
  function watch(kind) {
    const index = watches.length;
    let closed = false;
    const value = {
      traceID: String(index + 2).repeat(32),
      clientSpanID: "a".repeat(16),
      events: [
        {
          agent_id: "agent",
          availability: "ready",
          access_allowed: true,
          configuration_revision: "a".repeat(64),
          active_session_id: null,
          unavailable_reason: null,
        },
      ],
      closure: {
        kind: "transport-end",
        traceID: String(index + 2).repeat(32),
        observedAt: 2401,
        receivedEvents: 1,
      },
      async ready() {},
      assertOpen() {},
      close() {},
      snapshot() {
        return {
          agentId: "agent",
          traceID: this.traceID,
          clientSpanID: this.clientSpanID,
          events: this.events,
          closure: this.closure,
          joined: closed,
        };
      },
      async closeAndWait() {
        if (!closed) events.push(["watch-close", kind]);
        closed = true;
        if (errors.watchClose) throw errors.watchClose;
      },
    };
    watches.push(value);
    return value;
  }
  const access = {
    async open(agentId, browser) {
      events.push(["open", browser.accessToken]);
      let closed = false;
      const n = clients.length;
      const client = {
        connectionTraceID: String(n + 6).repeat(32),
        snapshot() {
          return {
            agentId,
            connectionTraceID: this.connectionTraceID,
            closed,
            initialization: {
              method: "initialize",
              kind: "request",
              requestId: `init-${n}`,
            },
            evidence: [
              {
                method: n ? "session/load" : "session/new",
                kind: "request",
                requestId: `business-${n}`,
              },
            ],
          };
        },
        async closeAndWait() {
          closed = true;
          events.push(["client-close", n]);
          if (errors.close) throw errors.close;
        },
      };
      clients.push(client);
      return client;
    },
    async watch() {
      return watch("private");
    },
    snapshots: () => clients.map((c) => c.snapshot()),
    watchSnapshots: () =>
      watches.filter((_, i) => i % 2 === 1).map((w) => w.snapshot()),
    async collect(row) {
      events.push([
        "collect",
        row.kind === "private_state_watch" ? "state" : row.requestId,
      ]);
      if (row.kind === "private_state_watch" && errors.privateTrace)
        throw errors.privateTrace;
      if (row.method === "initialize" && errors.collect) throw errors.collect;
      return { trace_id: row.traceID ?? row.requestId };
    },
    async closeAndWait() {
      events.push(["exporter"]);
      if (errors.exporter) throw errors.exporter;
    },
  };
  const transport = restoreTransportFixture();
  return {
    events,
    clients,
    watches,
    principal,
    owner,
    login,
    input: {
      config: {
        project: transport.project,
        evidence: "/fixture/evidence",
        jaeger: "http://jaeger",
      },
      signal: new AbortController().signal,
      traceSecrets: [],
      principal: encodeURIComponent(JSON.stringify(["org", "admin"])),
      async ready() {
        return { agent: { agent_id: "agent", owner_user_id: "member" } };
      },
    },
    dependencies: {
      async createAccess() {
        return access;
      },
      openPublic() {
        return watch("public");
      },
      async collectPublic() {
        events.push(["collect", "event"]);
        if (errors.publicTrace) throw errors.publicTrace;
        return { trace_id: watches[0].traceID };
      },
      async preservePublic() {
        events.push(["public-archive"]);
        if (errors.publicArchive) throw errors.publicArchive;
      },
      async preserveFailure() {
        events.push(["failure-archive"]);
        if (errors.archive) throw errors.archive;
      },
      async readTransport() {
        events.push(["transport"]);
        return structuredClone(transport);
      },
      async flush() {
        events.push(["flush"]);
      },
      async readModel() {
        events.push(["model"]);
        return { requests: [], errors: [] };
      },
    },
  };
}
async function initialize(f, input, adapter) {
  await input.ready("agent");
  adapter.login(f.owner, f.login);
  await adapter.watchPair({}, f.owner, f.principal, "agent");
  await adapter.open("agent", f.owner, f.principal);
}
test("Shutdown preserves the original abnormal ACP remote close before its business assertion", async () => {
  const f = fixture(),
    original = new Error("unexpected remote close");
  const receipt = { code: 1006, reason: "", at: 2401, localClose: false };
  const result = await implementation.runPrivateShutdown(
    f.input,
    async (input, adapter) => {
      await initialize(f, input, adapter);
      adapter.remoteClosed(receipt);
      throw original;
    },
    f.dependencies,
  );
  assert(result.shutdownErrors.includes(original));
  assert.deepEqual(result.private_shutdown.remote_acp_close, receipt);
  assert.equal(
    result.private_shutdown.remote_acp_connection,
    f.clients[0].connectionTraceID,
  );
});
for (const phase of ["initial", "stopped", "restarted"])
  test(`Shutdown preserves ${phase} inventory before a later business failure`, async () => {
    const f = fixture(),
      originalError = new Error("later business failure");
    const rows = [{ id: phase + "-container", running: phase !== "stopped" }];
    const originalRows = structuredClone(rows);
    const result = await implementation.runPrivateShutdown(
      f.input,
      async (input, adapter) => {
        await initialize(f, input, adapter);
        adapter.inventory(phase, rows);
        rows[0].id = "mutated";
        throw originalError;
      },
      f.dependencies,
    );
    assert(result.shutdownErrors.includes(originalError));
    assert.deepEqual(
      result.private_shutdown.platform_inventory[phase],
      originalRows,
    );
  });
test("Shutdown retains original business and sibling collection, archive, watch and exporter failures", async () => {
  assert.equal(typeof implementation.runPrivateShutdown, "function");
  const errors = Object.fromEntries(
    [
      "business",
      "watchClose",
      "close",
      "publicTrace",
      "privateTrace",
      "collect",
      "archive",
      "publicArchive",
      "exporter",
    ].map((name) => [name, new Error(name)]),
  );
  const f = fixture(errors);
  const result = await implementation.runPrivateShutdown(
    f.input,
    async (input, adapter) => {
      await initialize(f, input, adapter);
      throw errors.business;
    },
    f.dependencies,
  );
  for (const error of Object.values(errors))
    assert(result.shutdownErrors.includes(error), error.message);
  assert.equal(result.private_cleanup_completed, false);
  assert(!Object.keys(result).includes("shutdownErrors"));
  assert.equal(result.deleted_before_teardown, undefined);
  assert.deepEqual(
    f.events.filter((e) => e[0] === "collect"),
    [
      ["collect", "event"],
      ["collect", "state"],
      ["collect", "init-0"],
      ["collect", "business-0"],
    ],
  );
  assert.equal(f.events.at(-1)[0], "exporter");
});
test("Shutdown reuses one original login for two ACP connections and both private watches", async () => {
  assert.equal(typeof implementation.runPrivateShutdown, "function");
  const f = fixture();
  const result = await implementation.runPrivateShutdown(
    f.input,
    async (input, adapter) => {
      await initialize(f, input, adapter);
      await adapter.beforeStop();
      adapter.stopped(
        [],
        { start: 2000, complete: 2500 },
        {
          code: 1001,
          reason: "",
          at: 2401,
          localClose: false,
        },
      );
      await adapter.afterRestart();
      await input.ready("agent");
      await adapter.open("agent", f.owner, f.principal);
      await adapter.watchPair({}, f.owner, f.principal, "agent");
      return { same_session_recovered: true };
    },
    f.dependencies,
  );
  assert.deepEqual(result.shutdownErrors, []);
  assert.equal(result.private_cleanup_completed, true);
  assert.equal(result.private_shutdown.logins.length, 1);
  assert.equal(
    result.private_shutdown.remote_acp_connection,
    f.clients[0].connectionTraceID,
  );
  assert.equal(result.private_shutdown.delegations.length, 4);
  assert.equal(
    new Set(
      result.private_shutdown.delegations.map((row) => row.session_digest),
    ).size,
    1,
  );
  assert.equal(result.private_connections.length, 2);
  assert.equal(result.private_state_watches.length, 2);
  assert.equal(result.request_traces.length, 4);
  assert.equal(result.watch_traces.length, 2);
  assert.deepEqual(
    result.private_shutdown.public_watches.map((w) => w.joined),
    [true, true],
  );
});
for (const kind of [
  "new login",
  "changed Session",
  "foreign owner",
  "replaced transport",
])
  test(`Shutdown rejects ${kind} before admitting recovered access`, async () => {
    assert.equal(typeof implementation.runPrivateShutdown, "function");
    const f = fixture();
    let reads = 0;
    const read = f.dependencies.readTransport;
    f.dependencies.readTransport = async () => {
      const receipt = await read();
      if (++reads === 2 && kind === "replaced transport")
        receipt.rows[1].RestartCount++;
      return receipt;
    };
    const result = await implementation.runPrivateShutdown(
      f.input,
      async (input, adapter) => {
        await initialize(f, input, adapter);
        await adapter.beforeStop();
        await adapter.afterRestart();
        if (kind === "new login") adapter.login(f.owner, f.login);
        if (kind === "changed Session") f.owner.accessToken = "new-session";
        await adapter.open(
          "agent",
          f.owner,
          kind === "foreign owner"
            ? { ...f.principal, user_id: "foreign" }
            : f.principal,
        );
      },
      f.dependencies,
    );
    assert(result.shutdownErrors.length > 0);
    assert.equal(f.clients.length, 1);
  });
test("Shutdown parent abort joins watches, connections and exporter without further collection", async () => {
  assert.equal(typeof implementation.runPrivateShutdown, "function");
  const f = fixture(),
    abort = new AbortController(),
    reason = new Error("cancel Shutdown");
  f.input.signal = abort.signal;
  const result = await implementation.runPrivateShutdown(
    f.input,
    async (input, adapter) => {
      await initialize(f, input, adapter);
      abort.abort(reason);
      throw reason;
    },
    f.dependencies,
  );
  assert(result.shutdownErrors.includes(reason));
  assert(f.clients.every((c) => c.snapshot().closed));
  assert(f.watches.every((w) => w.snapshot().joined));
  assert(!f.events.some((e) => ["collect", "flush", "model"].includes(e[0])));
  assert.equal(f.events.at(-1)[0], "exporter");
});

for (const fails of [false, true])
  test(`Shutdown retains parent cancellation during the final exporter join${fails ? " alongside its own failure" : ""}`, async () => {
    const f = fixture(),
      abort = new AbortController(),
      reason = new Error("late parent cancellation"),
      exporter = new Error("independent exporter failure");
    f.input.signal = abort.signal;
    const create = f.dependencies.createAccess;
    f.dependencies.createAccess = async () => {
      const access = await create();
      const close = access.closeAndWait;
      access.closeAndWait = async () => {
        await close();
        abort.abort(reason);
        if (fails) throw exporter;
      };
      return access;
    };
    const result = await implementation.runPrivateShutdown(
      f.input,
      async (input, adapter) => {
        await initialize(f, input, adapter);
        return {};
      },
      f.dependencies,
    );
    assert(result.shutdownErrors.includes(reason));
    if (fails) assert(result.shutdownErrors.includes(exporter));
    assert.equal(result.private_connections.length, 1);
    assert.equal(result.request_traces.length, 2);
  });
