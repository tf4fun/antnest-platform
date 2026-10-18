import assert from "node:assert/strict";
import test from "node:test";
import { restoreTransportFixture } from "./restore-private-transport.fixture.mjs";
const url = new URL("./skill-restore-private-flow.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});

function fixture(errors = {}) {
  const principal = { organization_id: "org", user_id: "member" },
    events = [],
    clients = [];
  const login = (token, n) => ({
    owner: { accessToken: token },
    principal,
    response: {
      status: 200,
      traceID: String(n).repeat(32),
      body: { principal },
    },
  });
  const access = {
    async open(agentId, owner) {
      events.push(["open", owner.accessToken]);
      let closed = false;
      const client = {
        connectionTraceID: "connection-" + clients.length,
        snapshot() {
          return {
            agentId,
            connectionTraceID: this.connectionTraceID,
            closed,
            initialization: { method: "initialize", requestId: "a" },
            evidence: [{ method: "session/new", requestId: "b" }],
          };
        },
        async closeAndWait() {
          events.push(["close"]);
          closed = true;
          if (errors.close) throw errors.close;
        },
      };
      clients.push(client);
      return client;
    },
    snapshots: () => clients.map((c) => c.snapshot()),
    async collect(row) {
      events.push(["collect", row.requestId]);
      if (row.requestId === "a" && errors.collect) throw errors.collect;
      return { trace_id: row.requestId };
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
    login,
    principal,
    input: {
      config: { project: transport.project },
      signal: new AbortController().signal,
      traceSecrets: [],
      principal: encodeURIComponent(JSON.stringify(["org", "admin"])),
      async ready(agentID) {
        return { agent: { agent_id: agentID, owner_user_id: "member" } };
      },
    },
    dependencies: {
      async createDirectory() {
        return "/fixture/restore";
      },
      async removeDirectory() {
        events.push(["directory"]);
        if (errors.directory) throw errors.directory;
      },
      async createAccess() {
        return access;
      },
      async readModel() {
        events.push(["model"]);
        return [];
      },
      async flush() {
        events.push(["flush"]);
      },
      async readTransport() {
        events.push(["transport"]);
        return structuredClone(transport);
      },
      async preserveFailure() {
        events.push(["archive"]);
        if (errors.archive) throw errors.archive;
      },
    },
  };
}

test("Skill-restore returns partial evidence and original sibling errors after business, archive, exporter and directory cleanup failures", async () => {
  assert.equal(typeof implementation.runPrivateSkillRestore, "function");
  const errors = Object.fromEntries(
    ["business", "close", "collect", "archive", "exporter", "directory"].map(
      (name) => [name, new Error(name)],
    ),
  );
  const f = fixture(errors);
  const result = await implementation.runPrivateSkillRestore(
    f.input,
    async (input, directory, setClient, adapter) => {
      await input.ready("agent");
      const first = f.login("first-session", 1);
      adapter.login(first);
      await adapter.open("agent", first.owner, first.principal);
      throw errors.business;
    },
    f.dependencies,
  );
  for (const original of Object.values(errors))
    assert(result.restoreErrors.includes(original));
  assert.equal(result.deleted_before_teardown, undefined);
  assert.equal(result.private_cleanup_completed, false);
  assert.equal(result.profile, "offline-skill-restore");
  assert(!Object.keys(result).includes("restoreErrors"));
  assert.deepEqual(
    f.events.filter((e) =>
      ["collect", "archive", "exporter", "directory"].includes(e[0]),
    ),
    [
      ["collect", "a"],
      ["archive"],
      ["collect", "b"],
      ["exporter"],
      ["directory"],
    ],
  );
});

test("Skill-restore joins before recovery and binds all four connections to the two distinct login Sessions", async () => {
  assert.equal(typeof implementation.runPrivateSkillRestore, "function");
  for (const fault of [
    null,
    "reuse-session",
    "old-owner",
    "transport-restart",
  ]) {
    const f = fixture();
    let reads = 0;
    const originalRead = f.dependencies.readTransport;
    f.dependencies.readTransport = async () => {
      const value = await originalRead();
      if (++reads === 2 && fault === "transport-restart")
        value.rows[1].RestartCount++;
      return value;
    };
    const result = await implementation.runPrivateSkillRestore(
      f.input,
      async (input, directory, setClient, adapter) => {
        await input.ready("agent");
        const first = f.login("first-session", 1);
        adapter.login(first);
        await adapter.open("agent", first.owner, first.principal);
        await adapter.beforeQuiesce();
        assert.equal(f.clients[0].snapshot().closed, true);
        await adapter.afterRestore();
        const second = f.login(
          fault === "reuse-session" ? "first-session" : "second-session",
          2,
        );
        adapter.login(second);
        await adapter.open(
          "agent",
          fault === "old-owner" ? first.owner : second.owner,
          second.principal,
        );
        await input.ready("peer");
        await adapter.close(f.clients[1]);
        await adapter.open("peer", second.owner, second.principal);
        await adapter.close(f.clients[2]);
        await adapter.open("agent", second.owner, second.principal);
        return { completed_runs: 0 };
      },
      f.dependencies,
    );
    if (fault) {
      assert(result.restoreErrors.length > 0, fault);
      assert.equal(f.clients.length, 1, fault);
    } else {
      assert.deepEqual(result.restoreErrors, []);
      assert.equal(result.private_cleanup_completed, true);
      assert.equal(f.clients.length, 4);
      const work = result.private_skill_restore;
      assert.notEqual(
        work.logins[0].session_digest,
        work.logins[1].session_digest,
      );
      assert.deepEqual(
        work.delegations.map((r) => r.session_digest),
        [0, 1, 1, 1].map((i) => work.logins[i].session_digest),
      );
      assert.equal(work.pre_restore_connections[0].closed, true);
    }
  }
});

test("Skill-restore parent cancellation joins resources without starting more collectors", async () => {
  assert.equal(typeof implementation.runPrivateSkillRestore, "function");
  const f = fixture(),
    abort = new AbortController(),
    reason = new Error("stop restore");
  f.input.signal = abort.signal;
  const result = await implementation.runPrivateSkillRestore(
    f.input,
    async (input, directory, setClient, adapter) => {
      await input.ready("agent");
      const first = f.login("session", 1);
      adapter.login(first);
      await adapter.open("agent", first.owner, first.principal);
      abort.abort(reason);
      throw reason;
    },
    f.dependencies,
  );
  assert(result.restoreErrors.includes(reason));
  assert.equal(f.clients[0].snapshot().closed, true);
  assert(
    !f.events.some(([event]) => ["model", "flush", "collect"].includes(event)),
  );
  assert.deepEqual(f.events.slice(-2), [["exporter"], ["directory"]]);
});

test("Skill-restore retains pre-backup Provider evidence when compose up recreated the model before another service failed", async () => {
  const f = fixture(),
    failure = new Error("another service did not become healthy");
  const before = [
    { phase: "c5-before-backup", stage: "tool" },
    { phase: "c5-before-backup", stage: "reply" },
  ];
  const result = await implementation.runPrivateSkillRestore(
    f.input,
    async (input, directory, setClient, adapter) => {
      await input.ready("agent");
      const first = f.login("first-session", 1);
      adapter.login(first);
      await adapter.open("agent", first.owner, first.principal);
      adapter.modelInventory(before);
      await adapter.beforeQuiesce();
      // The new model is already empty, but compose up did not reach afterRestore.
      throw failure;
    },
    f.dependencies,
  );
  assert(result.restoreErrors.includes(failure));
  assert.deepEqual(result.private_skill_restore.before_model, before);
  assert.deepEqual(result.private_skill_restore.provider_requests, before);
  assert.deepEqual(result.private_skill_restore.unconfirmed_model, []);
});
