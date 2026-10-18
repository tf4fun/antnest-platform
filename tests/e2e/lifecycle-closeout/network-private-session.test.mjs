import assert from "node:assert/strict";
import test from "node:test";
import {
  foundationConnectionFixture,
  principal,
} from "./foundation-connection.fixture.mjs";
const { openFoundationConnection } =
  await import("./foundation-connection.mjs");

const url = new URL("./network-private-session.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const creationPrincipal = encodeURIComponent(
  JSON.stringify(["organization", "admin"]),
);
const agent = (id) => ({
  id,
  initial: { agent: { agent_id: id, owner_user_id: "owner" } },
});

test("Network preserves the member owner and creating organization while keeping admin policy identity separate", () => {
  assert.equal(typeof implementation.assertNetworkOwner, "function");
  implementation.assertNetworkOwner(principal, creationPrincipal, agent("a"));
  for (const changed of [
    { ...principal, user_id: "admin" },
    { ...principal, organization_id: "foreign" },
  ])
    assert.throws(() =>
      implementation.assertNetworkOwner(changed, creationPrincipal, agent("a")),
    );
  const changed = agent("a");
  changed.initial.agent.agent_id = "foreign";
  assert.throws(() =>
    implementation.assertNetworkOwner(principal, creationPrincipal, changed),
  );
});

test("Network starts both real private held Prompts before either completes, initializes once, and joins them", async (t) => {
  assert.equal(typeof implementation.createNetworkSessions, "function");
  const a = await foundationConnectionFixture(t),
    b = await foundationConnectionFixture(t);
  const opens = [];
  const sessions = implementation.createNetworkSessions({
    access: {
      async open(id, browser, actual) {
        assert.equal(browser, a.browser);
        assert.equal(actual, principal);
        const f = id === "a" ? a : b;
        const client = f.register(
          await openFoundationConnection(id, browser, {
            ...f.options,
            preserve() {},
          }),
        );
        opens.push(client);
        return client;
      },
    },
    owner: a.browser,
    principal,
    creationPrincipal,
    signal: new AbortController().signal,
  });
  const first = await sessions.start(agent("a"), {
    phase: "held-a",
    nonce: "a",
  });
  await a.entered;
  const second = await sessions.start(agent("b"), {
    phase: "held-b",
    nonce: "b",
  });
  await b.entered;
  const receipt = sessions.held("before-deny", first, second);
  assert.deepEqual(
    receipt.probes.map((p) => [p.phase, p.agent_id, p.settled]),
    [
      ["held-a", "a", false],
      ["held-b", "b", false],
    ],
  );
  assert.notEqual(
    receipt.probes[0].connection_trace_id,
    receipt.probes[1].connection_trace_id,
  );
  sessions.held("after-stale-cas", first, second);
  a.release();
  b.release();
  assert.equal(
    (await implementation.networkPromptResult(first)).stopReason,
    "end_turn",
  );
  assert.equal(
    (await implementation.networkPromptResult(second)).stopReason,
    "end_turn",
  );
  assert.throws(() => sessions.held("after-stale-cas", first, second));
  const errors = [];
  await sessions.closeAndWait(errors);
  assert.deepEqual(errors, []);
  for (const [i, f] of [a, b].entries()) {
    assert.deepEqual(
      f.wire.filter((r) => r.method).map((r) => r.method),
      ["initialize", "session/new", "session/prompt"],
    );
    assert.equal(opens[i].snapshot().closed, true);
    assert.deepEqual(f.permissions, [
      { outcome: { outcome: "selected", optionId: "once" } },
    ]);
  }
});

test("Network keeps original Prompt and cancellation errors together", async () => {
  assert.equal(typeof implementation.networkPromptResult, "function");
  const original = new Error("original prompt failure"),
    cancelled = new Error("parent cancelled");
  const signal = AbortSignal.abort(cancelled);
  const probe = { promise: Promise.resolve({ error: original }) };
  await assert.rejects(
    implementation.networkPromptResult(probe),
    (e) => e === original,
  );
  await assert.rejects(
    implementation.networkPromptResult(probe, signal),
    (e) =>
      e instanceof AggregateError &&
      e.errors.includes(original) &&
      e.errors.includes(cancelled),
  );
});

test("Network cleanup continues through every client and preserves business, archive, close and pending failures", async () => {
  assert.equal(typeof implementation.createNetworkSessions, "function");
  const business = new Error("business"),
    archive = new Error("archive"),
    close = new Error("close"),
    pending = new Error("pending");
  const joined = [],
    deadlines = [];
  const sessions = implementation.createNetworkSessions({
    owner: {},
    principal,
    creationPrincipal,
    access: {
      async open(id) {
        return {
          async request(method, params, timeout) {
            if (method === "new") return { sessionId: id };
            deadlines.push(timeout);
            throw pending;
          },
          async closeAndWait() {
            joined.push(id);
            throw id === "a" ? archive : close;
          },
        };
      },
    },
  });
  await sessions.start(agent("a"), { phase: "allowed" });
  await sessions.start(agent("b"), { phase: "held-b" });
  const errors = [business];
  await sessions.closeAndWait(errors);
  assert.deepEqual(joined, ["a", "b"]);
  assert.deepEqual(deadlines, [65000, 65000]);
  for (const error of [business, archive, close, pending])
    assert(errors.includes(error));
});

test("Network collects independent traces after collector and archive failures, preserving both originals", async () => {
  assert.equal(typeof implementation.collectNetworkTraces, "function");
  const original = new Error("original trace"),
    archive = new Error("archive"),
    errors = [],
    visited = [];
  const rows = await implementation.collectNetworkTraces(
    [{ traceID: "one" }, { traceID: "two" }],
    async (row) => {
      visited.push(row.traceID);
      if (row.traceID === "one") throw original;
      return { trace_id: row.traceID };
    },
    async () => {
      throw archive;
    },
    undefined,
    errors,
  );
  assert.deepEqual(visited, ["one", "two"]);
  assert.deepEqual(errors, [original, archive]);
  assert.deepEqual(
    rows.map((r) => r.topology),
    ["failed", "passed"],
  );
});

test("Network cleanup waits for a pending Prompt even after its client closes", async () => {
  assert.equal(typeof implementation.createNetworkSessions, "function");
  const prompt = Promise.withResolvers(),
    closed = Promise.withResolvers();
  const original = new Error("late pending failure"),
    errors = [];
  const sessions = implementation.createNetworkSessions({
    owner: {},
    principal,
    creationPrincipal,
    access: {
      async open() {
        return {
          request(method) {
            return method === "new"
              ? Promise.resolve({ sessionId: "session" })
              : prompt.promise;
          },
          async closeAndWait() {
            closed.resolve();
          },
        };
      },
    },
  });
  await sessions.start(agent("a"), { phase: "allowed" });
  let finished = false;
  const cleanup = sessions.closeAndWait(errors).then(() => {
    finished = true;
  });
  await closed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  prompt.reject(original);
  await cleanup;
  assert.equal(finished, true);
  assert(errors.includes(original));
});

test("Network retains and closes a connection whose new Session fails", async () => {
  assert.equal(typeof implementation.createNetworkSessions, "function");
  const original = new Error("new failed");
  let closed = false;
  const sessions = implementation.createNetworkSessions({
    owner: {},
    principal,
    creationPrincipal,
    access: {
      async open() {
        return {
          async request() {
            throw original;
          },
          async closeAndWait() {
            closed = true;
          },
        };
      },
    },
  });
  await assert.rejects(
    sessions.start(agent("a"), { phase: "allowed" }),
    (e) => e === original,
  );
  const errors = [original];
  await sessions.closeAndWait(errors);
  assert.equal(closed, true);
  assert(errors.includes(original));
});

test("Network retains collector, archive, final cleanup and later lifecycle errors until private business evidence is archived", () => {
  assert.equal(typeof implementation.recordNetworkFailures, "function");
  const failures = ["collector", "archive", "cleanup", "lifecycle"].map(
    (name) => new Error(name + " original failure"),
  );
  const result = implementation.recordNetworkFailures(
    { private_cleanup_completed: false },
    failures.slice(0, 3),
  );
  implementation.recordNetworkFailures(result, [failures[3]]);
  assert.deepEqual(result.networkErrors, failures);
  const archived = JSON.stringify(result);
  for (const failure of failures) assert(archived.includes(failure.message));
  assert(!Object.keys(result).includes("networkErrors"));
  assert.throws(
    () => implementation.networkFailures(result.networkErrors),
    (error) =>
      error instanceof AggregateError &&
      failures.every((failure) => error.errors.includes(failure)),
  );
});

test("Network closes all requests before collecting, and a cleanup error does not skip independent evidence", async () => {
  assert.equal(typeof implementation.afterNetworkRequestsClosed, "function");
  const original = new Error("connection archive failed"),
    errors = [],
    visited = [];
  const result = await implementation.afterNetworkRequestsClosed(
    {
      async closeAndWait(all) {
        visited.push("close");
        all.push(original);
      },
    },
    errors,
    async () => {
      for (const kind of ["request", "policy", "lifecycle"]) {
        await implementation.collectNetworkTraces(
          [{ kind }],
          async (row) => {
            visited.push(row.kind);
            return { kind: row.kind };
          },
          async () => {},
          undefined,
          errors,
        );
      }
      return "collected";
    },
  );
  assert.equal(result, "collected");
  assert.deepEqual(visited, ["close", "request", "policy", "lifecycle"]);
  assert.deepEqual(errors, [original]);
});

test("Network records a completed Prompt's first close failure without preventing the next phase", async () => {
  assert.equal(typeof implementation.closeNetworkConnection, "function");
  const original = new Error("first close archive failed"),
    errors = [],
    visited = [];
  await implementation.closeNetworkConnection(
    {
      async closeAndWait() {
        visited.push("first-close");
        throw original;
      },
    },
    errors,
  );
  visited.push("next-phase");
  assert.deepEqual(visited, ["first-close", "next-phase"]);
  assert.deepEqual(errors, [original]);
});
