import assert from "node:assert/strict";
import test from "node:test";
import {
  foundationConnectionFixture,
  principal,
  setup,
  prompt,
} from "./foundation-connection.fixture.mjs";
const url = new URL("./foundation-connection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const includesError = (error, original) =>
  error === original ||
  (error.errors ?? []).some((item) => includesError(item, original));

async function open(t, options = {}) {
  assert.equal(typeof implementation.openFoundationConnection, "function");
  const f = await foundationConnectionFixture(t),
    saved = [];
  const client = f.register(
    await implementation.openFoundationConnection("agent", f.browser, {
      ...f.options,
      preserve: (snapshot) => saved.push(structuredClone(snapshot)),
      ...options,
    }),
  );
  return { ...f, client, saved };
}

test(
  "Foundation preserves original authority, allow_once and concurrent held/busy wire receipts",
  { timeout: 10000 },
  async (t) => {
    const f = await open(t),
      c = f.client;
    const first = (await c.request("new", setup)).sessionId;
    const other = (await c.request("new", setup)).sessionId;
    let settled = false;
    const held = c
      .request("prompt", prompt(first), 180000, {
        kind: "ordinary",
        phase: "c3-held-run",
      })
      .finally(() => {
        settled = true;
      });
    await f.entered;
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        c.request("prompt", prompt(other), 15000, { rejection: "agent_busy" }),
        (error) =>
          error.code === -32020 &&
          error.data.code === "agent_busy" &&
          error.data.retryable === false,
      );
      assert.equal(settled, false);
    }
    f.release();
    assert.equal((await held).stopReason, "end_turn");
    await c.closeAndWait();
    const snapshot = c.snapshot();
    assert.equal(snapshot.closed, true);
    assert.equal(snapshot.initialization.method, "initialize");
    assert.deepEqual(
      snapshot.requests.map((r) => r.requestId),
      [snapshot.initialization, ...snapshot.evidence].map((r) => r.requestId),
    );
    const receipts = snapshot.evidence.filter(
      (r) => r.method === "session/prompt",
    );
    assert.deepEqual(
      receipts.map((r) => [r.inputSessionID, r.outcome]),
      [
        [first, "succeeded"],
        [other, "failed"],
        [other, "failed"],
      ],
    );
    assert.equal(new Set(receipts.map((r) => r.requestId)).size, 3);
    for (const row of receipts) {
      const actual = f.wire.find(
        (x) => String(x.id) === row.requestId && x.method === row.method,
      );
      assert.deepEqual(actual.params, row.requestParams);
    }
    for (const row of receipts.slice(1))
      assert.deepEqual(row.rejectionReceipt, {
        rpcCode: -32020,
        code: "agent_busy",
        retryable: false,
      });
    assert.deepEqual(f.identities[0].body, {
      access_token: f.browser.accessToken,
      profile: "workspace",
      agent_id: "agent",
    });
    assert.deepEqual(f.options.principal, principal);
    assert.equal(f.permissions.length, 1);
    assert.deepEqual(f.saved.at(-1), snapshot);
    snapshot.evidence[0].requestParams.cwd = "mutated";
    assert.equal(c.snapshot().evidence[0].requestParams.cwd, "/workspace");
  },
);

test(
  "Foundation parent abort after initialization closes the socket and joins its pending prompt",
  { timeout: 10000 },
  async (t) => {
    const abort = new AbortController(),
      f = await open(t, { signal: abort.signal });
    const reason = new Error("foundation cancelled");
    const session = (await f.client.request("new", setup)).sessionId;
    const held = f.client.request("prompt", prompt(session), 180000);
    const rejected = assert.rejects(held, (error) =>
      includesError(error, reason),
    );
    await f.entered;
    abort.abort(reason);
    await rejected;
    await f.client.closeAndWait();
    assert.equal(f.client.snapshot().closed, true);
    assert.equal(f.client.snapshot().evidence.at(-1).outcome, "failed");
    await assert.rejects(f.client.request("new", setup));
  },
);

test(
  "Foundation refuses an ambiguous same-session overlap without sending a second RPC",
  { timeout: 10000 },
  async (t) => {
    const f = await open(t),
      session = (await f.client.request("new", setup)).sessionId;
    const held = f.client.request("prompt", prompt(session));
    await f.entered;
    await assert.rejects(
      f.client.request("prompt", prompt(session)),
      /ambiguous|overlap/u,
    );
    assert.equal(f.wire.filter((r) => r.method === "session/prompt").length, 1);
    f.release();
    await held;
    await f.client.closeAndWait();
  },
);

test(
  "Foundation retains both a real busy rejection and its failed archive through close",
  { timeout: 10000 },
  async (t) => {
    const archiveError = new Error("private archive failed");
    const f = await open(t, {
      preserve(snapshot) {
        if (snapshot.evidence.some((r) => r.rejectionReceipt))
          throw archiveError;
      },
    });
    const first = (await f.client.request("new", setup)).sessionId;
    const other = (await f.client.request("new", setup)).sessionId;
    const held = f.client
      .request("prompt", prompt(first))
      .catch((error) => error);
    await f.entered;
    await assert.rejects(f.client.request("prompt", prompt(other)), (error) => {
      assert(error instanceof AggregateError);
      assert(error.errors.includes(archiveError));
      assert(
        error.errors.some(
          (value) => value.code === -32020 && value.data.code === "agent_busy",
        ),
      );
      return true;
    });
    f.release();
    await held;
    await assert.rejects(
      f.client.closeAndWait(),
      (error) => error === archiveError || error.errors?.includes(archiveError),
    );
    assert.equal(f.client.snapshot().closed, true);
    assert(f.client.snapshot().evidence_errors.length > 0);
  },
);

test("Foundation closing rejects a changed original wire identity", async (t) => {
  const f = await open(t);
  await f.client.request("new", setup);
  f.client.requests[1].sessionId = "foreign";
  await assert.rejects(f.client.closeAndWait());
});

test("Foundation cannot return a live client when initial archival aborts its parent", async (t) => {
  const abort = new AbortController(),
    reason = new Error("initial archive cancellation");
  await assert.rejects(
    open(t, {
      signal: abort.signal,
      preserve() {
        abort.abort(reason);
      },
    }),
    (error) => includesError(error, reason),
  );
});

test("Foundation initial archive failure cannot erase simultaneous cancellation", async (t) => {
  const abort = new AbortController(),
    reason = new Error("initial cancellation"),
    archive = new Error("initial archive failed");
  await assert.rejects(
    open(t, {
      signal: abort.signal,
      preserve() {
        abort.abort(reason);
        throw archive;
      },
    }),
    (error) => includesError(error, reason) && includesError(error, archive),
  );
});

test("Foundation preserves a successful wire response but rejects cancellation during its archive", async (t) => {
  const abort = new AbortController(),
    reason = new Error("response archive cancellation");
  const f = await open(t, {
    signal: abort.signal,
    preserve(snapshot) {
      if (snapshot.evidence.some((row) => row.outcome === "succeeded"))
        abort.abort(reason);
    },
  });
  await assert.rejects(f.client.request("new", setup), (error) =>
    includesError(error, reason),
  );
  await f.client.closeAndWait();
  assert.equal(f.client.snapshot().evidence[0].outcome, "succeeded");
  assert.equal(
    f.client.snapshot().raw_frames.some((frame) => frame.result?.sessionId),
    true,
  );
});
