import assert from "node:assert/strict";
import test from "node:test";
import {
  foundationConnectionFixture,
  setup,
} from "../lifecycle-closeout/foundation-connection.fixture.mjs";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
const { inspectPrivateNotificationReceipt } =
  await import("../identity-closeout/acp-connection.mjs");

const url = new URL("./private-connection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const contains = (error, original) =>
  error === original ||
  (error?.errors ?? []).some((item) => contains(item, original));
const input = (sessionId, phase) => ({
  sessionId,
  prompt: [{ type: "text", text: phase }],
});
async function open(t, options = {}) {
  assert.equal(typeof implementation.openWorkspaceConnection, "function");
  const f = await foundationConnectionFixture(t);
  const saved = [];
  const client = f.register(
    await implementation.openWorkspaceConnection("agent", f.browser, {
      ...f.options,
      preserve: (value) => saved.push(structuredClone(value)),
      ...options,
    }),
  );
  return { ...f, client, saved };
}

test("Workspace keeps one actual initialize, original authority and lossless successful RPCs", async (t) => {
  const f = await open(t);
  const { sessionId } = await f.client.request("new", setup);
  await f.client.request("load", { ...setup, sessionId });
  const closing = f.client.closeAndWait();
  assert.strictEqual(f.client.closeAndWait(), closing);
  await closing;
  const result = f.client.snapshot();
  checkPrivateACPConnection(result);
  assert.deepEqual(result.deliberate_disconnects, []);
  assert.equal(result.close_receipt.localClose, true);
  assert.equal(f.identities.length, 1);
  assert.equal(f.identities[0].body.access_token, f.browser.accessToken);
  assert.deepEqual(
    result.requests.map((r) => r.method),
    ["initialize", "session/new", "session/load"],
  );
  assert.deepEqual(result.evidence[0].requestParams, setup);
  assert.equal(result.evidence[0].requestResult.sessionId, sessionId);
  assert.deepEqual(f.saved.at(-1), result);
  result.evidence[0].requestParams.cwd = "/foreign";
  assert.equal(f.client.snapshot().evidence[0].requestParams.cwd, "/workspace");
  await assert.rejects(f.client.request("new", setup));
});

for (const phase of ["c4-cancel", "c4-offline"]) {
  test(
    "Workspace binds " +
      phase +
      " to the original pending Prompt, actual close and error identity",
    { timeout: 10000 },
    async (t) => {
      const f = await open(t);
      const { sessionId } = await f.client.request("new", setup);
      const params = input(sessionId, phase);
      const pending = f.client.request("prompt", params).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await f.entered;
        await f.client.disconnectPending(phase);
        const { error } = await pending;
        assert(error instanceof Error);
        assert.equal(f.client.isLocalCloseError(error), true);
        assert.equal(
          f.client.isLocalCloseError(new Error(error.message)),
          false,
        );
        const snapshot = f.client.snapshot();
        checkPrivateACPConnection(snapshot);
        assert.equal(snapshot.evidence.at(-1).closedBeforeResponse, undefined);
        assert.deepEqual(snapshot.evidence.at(-1).requestParams, params);
        assert.match(snapshot.evidence.at(-1).failure, /Error/);
        const [receipt] = f.client.disconnectReceipts;
        const proof = implementation.inspectWorkspaceDisconnect(receipt);
        assert.equal(proof.phase, phase);
        assert.equal(proof.sessionId, sessionId);
        assert.equal(proof.requestId, snapshot.evidence.at(-1).requestId);
        assert.equal(proof.connectionTraceID, snapshot.connectionTraceID);
        assert.equal(proof.close.localClose, true);
        assert.equal(proof.original_local_close_error, true);
        assert.equal(proof.response_absent, true);
        assert.deepEqual(snapshot.deliberate_disconnects, [proof]);
        assert.deepEqual(f.saved.at(-1), snapshot);
        assert.throws(() =>
          implementation.inspectWorkspaceDisconnect(structuredClone(receipt)),
        );
        receipt.phase = phase === "c4-cancel" ? "c4-offline" : "c4-cancel";
        assert.throws(() => implementation.inspectWorkspaceDisconnect(receipt));
      } finally {
        f.release();
        await pending;
        await f.client.closeAndWait();
      }
    },
  );
}

test(
  "Workspace notification retains its original terminal receipt and is separate from RPC inventory",
  { timeout: 10000 },
  async (t) => {
    const f = await open(t);
    const { sessionId } = await f.client.request("new", setup);
    await f.client.notify("cancel", { sessionId });
    await f.client.closeAndWait();
    const [receipt] = f.client.notificationReceipts;
    assert.equal(inspectPrivateNotificationReceipt(receipt), receipt);
    assert.equal(receipt.method, "session/cancel");
    assert.equal(receipt.requestId, undefined);
    const snapshot = f.client.snapshot();
    assert.equal(snapshot.requests.length, 2);
    assert.equal(snapshot.notifications.length, 1);
    assert.deepEqual(snapshot.notifications[0], receipt);
  },
);

test(
  "Workspace parent abort joins a real held request without a deliberate-disconnect classification",
  { timeout: 10000 },
  async (t) => {
    const abort = new AbortController();
    const f = await open(t, { signal: abort.signal });
    const { sessionId } = await f.client.request("new", setup);
    const reason = new Error("original workspace cancellation");
    const pending = f.client
      .request("prompt", input(sessionId, "c4-cancel"))
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await f.entered;
      abort.abort(reason);
      assert(contains((await pending).error, reason));
      await assert.rejects(f.client.closeAndWait(), (error) =>
        contains(error, reason),
      );
      assert.equal(f.client.snapshot().closed, true);
      assert.deepEqual(f.client.snapshot().deliberate_disconnects, []);
    } finally {
      f.release();
      await pending;
      await f.client.closeAndWait().catch(() => {});
    }
  },
);

test(
  "Workspace archives the original failed Prompt even when its archive also fails",
  { timeout: 10000 },
  async (t) => {
    const archiveError = new Error("original archive failure");
    let failArchive = false;
    const f = await open(t, {
      preserve(value) {
        if (failArchive && value.evidence.some((r) => r.outcome === "failed"))
          throw archiveError;
      },
    });
    const { sessionId } = await f.client.request("new", setup);
    const params = input(sessionId, "c4-offline");
    const pending = f.client.request("prompt", params).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await f.entered;
      failArchive = true;
      await assert.rejects(f.client.disconnectPending("c4-offline"), (error) =>
        contains(error, archiveError),
      );
      const result = await pending;
      assert(contains(result.error, archiveError));
      assert(
        result.error.errors.some((error) => f.client.isLocalCloseError(error)),
      );
      const snapshot = f.client.snapshot();
      assert.deepEqual(snapshot.evidence.at(-1).requestParams, params);
      assert.equal(snapshot.evidence.at(-1).outcome, "failed");
      assert(snapshot.evidence_errors.length > 0);
      for (const receipt of f.client.disconnectReceipts)
        assert.throws(() => implementation.inspectWorkspaceDisconnect(receipt));
    } finally {
      f.release();
      await pending;
      await f.client.closeAndWait().catch(() => {});
    }
  },
);

// These doubles exercise adverse transport races without changing the SDK.
// Successful protocol provenance is separately exercised with real HTTP/WS above.
async function adverse(options = {}) {
  assert.equal(typeof implementation.recordWorkspaceConnection, "function");
  let requestID = 1,
    pending,
    closed = false;
  const cause = new Error("local close");
  const transport = {
    boundary: "private-acp",
    transport: "websocket",
    version: 1,
    agentId: "agent",
    connectionTraceID: "a".repeat(32),
    clientSpanID: "b".repeat(16),
    initializationResult: { protocolVersion: 1 },
    requests: [{ requestId: "1", method: "initialize" }],
    rawFrames: [{ id: "1", result: { protocolVersion: 1 } }],
    updates: [],
    notifications: [],
    isLocalCloseError: (error) => error === cause,
    request(name, params) {
      const row = {
        requestId: String(++requestID),
        method: "session/" + name,
        sessionId: params.sessionId,
      };
      if (!options.missingWire) this.requests.push(row);
      pending = Promise.withResolvers();
      return pending.promise;
    },
    async closeAndWait() {
      if (options.replyBeforeClose)
        this.rawFrames.push({
          id: String(requestID),
          result: { stopReason: "end_turn" },
        });
      pending?.reject(options.requestError ?? cause);
      if (options.closeError) throw options.closeError;
      closed = true;
      return {
        code: options.closeCode ?? 1000,
        reason: "",
        at: Date.now(),
        localClose: options.remote !== true,
      };
    },
  };
  const saved = [];
  const client = await implementation.recordWorkspaceConnection(transport, {
    preserve: (value) => saved.push(structuredClone(value)),
    signal: options.signal,
  });
  return {
    client,
    transport,
    cause,
    saved,
    get closed() {
      return closed;
    },
  };
}

for (const [name, options] of [
  ["same-shaped unrelated error", { requestError: new Error("local close") }],
  ["response arriving before close joins", { replyBeforeClose: true }],
  ["a remote close", { remote: true }],
  ["an abnormal socket close", { closeCode: 1006 }],
  ["cleanup failure", { closeError: new Error("original socket cleanup") }],
]) {
  test("Workspace refuses deliberate-close proof for " + name, async () => {
    const f = await adverse(options);
    const pending = f.client
      .request("prompt", input("session", "c4-cancel"))
      .catch((error) => error);
    // The actual wire request has to exist before choosing it.
    await Promise.resolve();
    await assert.rejects(f.client.disconnectPending("c4-cancel"));
    await pending;
    for (const receipt of f.client.disconnectReceipts)
      assert.throws(() => implementation.inspectWorkspaceDisconnect(receipt));
    assert.equal(
      f.client.snapshot().evidence.at(-1).closedBeforeResponse,
      undefined,
    );
    if (options.closeError)
      await assert.rejects(f.client.closeAndWait(), (error) =>
        contains(error, options.closeError),
      );
  });
}

for (const [name, method, phase, options] of [
  ["foreign phase", "prompt", "c4-offline", {}],
  ["arbitrary phase", "prompt", "borrowed", {}],
  ["non-Prompt request", "load", "c4-cancel", {}],
  ["missing actual wire request", "prompt", "c4-cancel", { missingWire: true }],
]) {
  test(
    "Workspace refuses to select " + name + " for deliberate disconnect",
    async () => {
      const f = await adverse(options);
      const pending = f.client
        .request(method, input("session", "c4-cancel"))
        .catch((error) => error);
      await Promise.resolve();
      try {
        await assert.rejects(async () => f.client.disconnectPending(phase));
        assert.equal(f.closed, false);
      } finally {
        await f.client.closeAndWait().catch(() => {});
        await pending;
      }
      assert.deepEqual(f.client.snapshot().deliberate_disconnects, []);
    },
  );
}

test("Workspace refuses an already-completed request and keeps ordinary cleanup unclassified", async (t) => {
  const f = await open(t);
  await f.client.request("new", setup);
  await assert.rejects(async () => f.client.disconnectPending("c4-cancel"));
  await f.client.closeAndWait();
  assert.deepEqual(f.client.snapshot().deliberate_disconnects, []);
});
