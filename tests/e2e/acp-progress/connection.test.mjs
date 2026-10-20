import assert from "node:assert/strict";
import test from "node:test";
import {
  commandFixture,
  principal,
  setup,
} from "../acp-commands/connection.fixture.mjs";
import { until } from "../acp-closeout/wait.mjs";

const url = new URL("./connection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const { inspectPrivateNotificationReceipt } =
  await import("../identity-closeout/acp-connection.mjs");
const profiles = [1, 2].map((version) => ({ name: `v${version}-ws`, version }));
async function fixture(t, profile, peer = {}) {
  assert.equal(typeof implementation.openPrivateProgressConnection, "function");
  const f = await commandFixture(t, profile, peer);
  return {
    ...f,
    open: async (overrides = {}) =>
      f.register(
        await implementation.openPrivateProgressConnection(
          profile.version,
          "agent",
          f.browser,
          { ...f.options, ...overrides },
        ),
      ),
  };
}

test("a real SDK serialization failure cannot become a replay-disconnect receipt", async (t) => {
  let serializationFailures = 0;
  for (const turns of [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32]) {
    const f = await fixture(t, profiles[0]);
    const client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const pending = client
      .request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "phase" }],
        _meta: { unserializable: 1n },
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    let response;
    try {
      for (let turn = 0; turn < turns; turn++) await Promise.resolve();
      await client.disconnectForReplay().catch(() => {});
      await client.closeAndWait();
      response = await pending;
    } finally {
      await client.closeAndWait();
      await pending;
    }
    if (response.error instanceof TypeError) {
      serializationFailures++;
      assert.match(response.error.message, /BigInt/);
      assert.equal(client.isLocalCloseError(response.error), false);
      assert.equal(
        client.lastRequest.closedBeforeResponse,
        undefined,
        `SDK failure at ${turns} microtask turns`,
      );
    }
  }
  assert(
    serializationFailures > 0,
    "must observe the real SDK serialization failure",
  );
});

for (const profile of profiles) {
  test(`${profile.name}: Progress records actual private initialize, setup and replay separately`, async (t) => {
    const f = await fixture(t, profile),
      client = await f.open();
    assert.equal(client.boundary, "private-acp");
    assert.equal(client.transport, "websocket");
    assert.equal(client.initializationRequest.method, "initialize");
    assert.equal(client.initializationRequest.inputSessionID, null);
    assert.deepEqual(
      client.initializationRequest.initializationResult,
      client.initializationResult,
    );
    assert.deepEqual(client.requestEvidence, []);
    const { sessionId } = await client.request("new", setup);
    await client.request(profile.version === 1 ? "load" : "resume", {
      ...setup,
      sessionId,
      ...(profile.version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    assert.deepEqual(
      client.requestEvidence.map((row) => row.method),
      [
        "session/new",
        profile.version === 1 ? "session/load" : "session/resume",
      ],
    );
    assert.equal(client.requests.length, 3);
    for (const row of [
      client.initializationRequest,
      ...client.requestEvidence,
    ]) {
      assert.equal(row.agentId, "agent");
      assert.equal(row.protocolVersion, profile.version);
      assert.equal(row.connectionTraceID, client.connectionTraceID);
      assert.equal(row.clientSpanID, client.clientSpanID);
      const wire = client.requests.filter(
        (item) => item.requestId === row.requestId,
      );
      assert.equal(wire.length, 1);
      assert.equal(wire[0].method, row.method);
      assert.equal(row.outcome, "succeeded");
    }
    assert.equal(client.requestEvidence[0].inputSessionID, null);
    assert.equal(client.requestEvidence[0].sessionId, sessionId);
    assert.equal(client.requestEvidence[1].inputSessionID, sessionId);
    assert.equal(f.identities.length, 1);
    assert.equal(f.identities[0].body.access_token, f.browser.accessToken);
    assert.equal(f.wire[0].headers.cookie, undefined);
    await client.closeAndWait();
  });

  test(`${profile.name}: cancel can be written while prompt waits and close joins all original evidence`, async (t) => {
    const f = await fixture(t, profile, { holdPrompt: true }),
      client = await f.open();
    const { sessionId } = await client.request("new", setup);
    let settled = false;
    const pending = client
      .request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "phase" }],
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await f.promptStarted;
      assert.equal(settled, false);
      await client.notify("cancel", { sessionId });
      await until(
        () => f.calls.some((row) => row.method === "session/cancel"),
        "actual peer notification",
        2000,
      );
      assert.equal(settled, false);
      assert.equal(client.lastNotification.method, "session/cancel");
      assert.equal(client.lastNotification.requestId, undefined);
      assert.throws(() =>
        inspectPrivateNotificationReceipt(client.lastNotification),
      );
      const closing = client.closeAndWait();
      assert.strictEqual(client.closeAndWait(), closing);
      await closing;
      assert(settled);
      assert((await pending).error instanceof Error);
      assert.equal(client.requestEvidence.length, 2);
      assert.equal(client.lastRequest.method, "session/prompt");
      assert.equal(client.lastRequest.outcome, "failed");
      assert.equal(
        client.lastRequest.closedBeforeResponse,
        undefined,
        "ordinary close is not the replay-disconnect proof",
      );
      assert.strictEqual(
        inspectPrivateNotificationReceipt(client.lastNotification).sessionId,
        sessionId,
      );
    } finally {
      f.releasePrompt();
      await pending;
      await client.closeAndWait();
    }
  });

  test(`${profile.name}: explicit replay disconnect retains actual outstanding prompt identity`, async (t) => {
    const f = await fixture(t, profile, { holdPrompt: true }),
      client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const pending = client
      .request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "phase" }],
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await f.promptStarted;
      await client.disconnectForReplay();
      const { error } = await pending;
      assert(error instanceof Error);
      assert.equal(client.isLocalCloseError(error), true);
      assert.equal(client.isLocalCloseError(new Error(error.message)), false);
      assert.equal(client.isLocalCloseError(undefined), false);
      assert.equal(client.lastRequest.sessionId, sessionId);
      assert.equal(
        client.lastRequest.closedBeforeResponse,
        profile.version === 1 ? true : undefined,
      );
      assert.equal(client.lastRequest.requestReceipt, undefined);
      assert.equal(client.lastRequest.outcome, "failed");
      assert.equal(
        client.requests.at(-1).requestId,
        client.lastRequest.requestId,
      );
    } finally {
      f.releasePrompt();
      await pending;
      await client.closeAndWait();
    }
  });

  test(`${profile.name}: replay disconnect after a successful reply does not invent a closed response`, async (t) => {
    const f = await fixture(t, profile),
      client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const result = await client.request("prompt", {
      sessionId,
      prompt: [{ type: "text", text: "phase" }],
    });
    await client.disconnectForReplay();
    assert.equal(client.lastRequest.outcome, "succeeded");
    assert.deepEqual(client.lastRequest.requestReceipt.result, result);
    assert.equal(client.lastRequest.closedBeforeResponse, undefined);
  });

  test(`${profile.name}: unexpected peer close cannot mint replay-disconnect evidence`, async (t) => {
    const f = await fixture(t, profile, { holdPrompt: true }),
      client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const pending = client
      .request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "phase" }],
      })
      .catch((error) => error);
    try {
      await f.promptStarted;
      [...f.sockets.clients][0].terminate();
      assert((await pending) instanceof Error);
      assert.equal(client.lastRequest.closedBeforeResponse, undefined);
      await assert.rejects(client.disconnectForReplay(), /closed|disconnect/);
    } finally {
      f.releasePrompt();
      await pending;
      await client.closeAndWait();
    }
  });

  test(`${profile.name}: real barrier rejection retains exact original error and wire identity`, async (t) => {
    const f = await fixture(t, profile, { barrierPrompt: true }),
      client = await f.open();
    const { sessionId } = await client.request("new", setup);
    await assert.rejects(
      client.request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "blocked" }],
      }),
      (error) =>
        error.code === -32020 &&
        error.data?.code === "runtime_barrier_required" &&
        error.data?.retryable === false,
    );
    assert.equal(client.lastRequest.outcome, "rejected");
    assert.equal(client.lastRequest.rejection, "runtime_barrier_required");
    assert.deepEqual(client.lastRequest.rejectionReceipt, {
      rpcCode: -32020,
      code: "runtime_barrier_required",
      retryable: false,
    });
    assert.equal(client.lastRequest.requestReceipt, undefined);
    assert.equal(client.lastRequest.closedBeforeResponse, undefined);
    await client.closeAndWait();
  });

  test(`${profile.name}: overlapping request and non-prompt replay disconnect cannot alter held setup`, async (t) => {
    const f = await fixture(t, profile, { holdNew: true }),
      client = await f.open();
    const pending = client.request("new", setup);
    void pending.catch(() => {});
    try {
      await f.newStarted;
      await assert.rejects(client.request("new", setup), /overlap/);
      await assert.rejects(client.disconnectForReplay(), /prompt/);
      assert.equal(
        f.calls.filter((row) => row.method === "session/new").length,
        1,
      );
      f.releaseNew();
      await pending;
      assert.equal(client.requestEvidence.length, 1);
    } finally {
      f.releaseNew();
      await pending.catch(() => {});
      await client.closeAndWait();
    }
  });

  test(`${profile.name}: caller mutations cannot change original params, replies or stored evidence`, async (t) => {
    const f = await fixture(t, profile, { holdNew: true }),
      client = await f.open();
    const params = structuredClone(setup),
      pending = client.request("new", params);
    void pending.catch(() => {});
    try {
      await f.newStarted;
      params.cwd = "/mutated";
      f.releaseNew();
      const result = await pending,
        original = structuredClone(result);
      result.sessionId = "mutated";
      const evidence = client.requestEvidence;
      evidence[0].requestReceipt.result.sessionId = "mutated again";
      assert.deepEqual(client.lastRequest.requestReceipt.params, setup);
      assert.deepEqual(client.lastRequest.requestReceipt.result, original);
      assert.equal(client.lastRequest.sessionId, original.sessionId);
      assert.deepEqual(
        f.calls.find((row) => row.method === "session/new").params,
        setup,
      );
    } finally {
      f.releaseNew();
      await pending.catch(() => {});
      await client.closeAndWait();
    }
  });

  test(`${profile.name}: admission after close has no new RPC`, async (t) => {
    const f = await fixture(t, profile),
      client = await f.open();
    await client.closeAndWait();
    await assert.rejects(client.request("new", setup), /closing|closed/);
    assert.equal(client.requests.length, 1);
    assert.deepEqual(client.requestEvidence, []);
  });

  for (const field of ["organization_id", "user_id"])
    test(`${profile.name}: original ${field} must match delegated identity`, async (t) => {
      const f = await fixture(t, profile);
      await assert.rejects(
        f.open({ principal: { ...principal, [field]: "foreign" } }),
        /authority changed/,
      );
      assert.equal(f.wire.length, 0);
    });
}
