import assert from "node:assert/strict";
import test from "node:test";

const load = () => import("./session-close.mjs");

test("remote close observation keeps its time, reason and local-close provenance", async () => {
  const { createSessionCloseObserver } = await load();
  const remote = createSessionCloseObserver(() => 500);
  const pending = remote.wait(100);
  remote.record(1008, Buffer.from("session_rejected"));
  assert.deepEqual(await pending, {
    code: 1008,
    reason: "session_rejected",
    at: 500,
    localClose: false,
  });
  remote.markLocalClose();
  assert.equal((await remote.wait(100)).localClose, false);
  const local = createSessionCloseObserver(() => 600);
  local.markLocalClose();
  local.record(1008, Buffer.from("session_rejected"));
  assert.equal((await local.wait(100)).localClose, true);
  await assert.rejects(
    createSessionCloseObserver().wait(5),
    /close.*timed out/,
  );
});

function fixture() {
  const requests = [{ method: "session/new", requestId: "1" }];
  const event = {
    code: 1008,
    reason: "session_rejected",
    at: 500,
    localClose: false,
  };
  return {
    traceID: "a".repeat(32),
    agentId: "agent-1",
    version: 2,
    requests,
    event,
    waitForClose: async () => event,
    request: async () => {
      throw new Error("connection already closed");
    },
  };
}

test("silent close requires remote closure before a locally rejected SDK request", async () => {
  const { sessionCloseCheckpoint, expectSilentSessionClose } = await load();
  const client = fixture();
  const before = sessionCloseCheckpoint(client, () => 100);
  const result = await expectSilentSessionClose(
    client,
    before,
    "revoked",
    "prompt",
    {},
  );
  assert.equal(result.connectionTraceID, client.traceID);
  assert.equal(result.closeCode, 1008);
  assert.equal(result.closeReason, "session_rejected");
  assert.equal(result.closedAt, 500);
  assert.equal(result.requestCount, 1);
  assert.equal(result.postCloseRequestSent, false);
  assert.equal(result.localClose, false);
});

test("local shutdown, wrong close cause, early closure and stale closure cannot pass", async () => {
  const { sessionCloseCheckpoint, expectSilentSessionClose } = await load();
  for (const patch of [
    { localClose: true },
    { code: 1006 },
    { reason: "caller_context_expired" },
    { at: 99 },
    { at: 30101 },
  ]) {
    const client = fixture();
    const before = sessionCloseCheckpoint(client, () => 100);
    Object.assign(client.event, patch);
    await assert.rejects(
      expectSilentSessionClose(client, before, "revoked", "prompt", {}),
    );
  }
});

test("silent close rejects extra or rewritten SDK requests before and after closure", async () => {
  const { sessionCloseCheckpoint, expectSilentSessionClose } = await load();
  for (const mutate of [
    (client) =>
      client.requests.push({ method: "session/prompt", requestId: "2" }),
    (client) => {
      client.requests[0].method = "session/prompt";
    },
    (client) => {
      client.request = async () => {
        client.requests.push({ method: "session/prompt", requestId: "2" });
        throw new Error("write failed after sending");
      };
    },
    (client) => {
      client.request = async () => ({});
    },
  ]) {
    const client = fixture();
    const before = sessionCloseCheckpoint(client, () => 100);
    mutate(client);
    await assert.rejects(
      expectSilentSessionClose(client, before, "revoked", "prompt", {}),
    );
  }
});

test("outage and expiry retain their distinct peer close reasons", async () => {
  const { sessionCloseCheckpoint, expectSilentSessionClose } = await load();
  for (const [reason, code, text] of [
    ["unavailable", 1013, "identity_unavailable"],
    ["expired", 1008, "caller_context_expired"],
    ["expired", 1008, "session_rejected"],
  ]) {
    const client = fixture();
    Object.assign(client.event, { code, reason: text });
    const before = sessionCloseCheckpoint(client, () => 100);
    if (reason === "expired") before.expiresAt = 1500;
    assert.equal(
      (await expectSilentSessionClose(client, before, reason, "list", {}))
        .reason,
      reason,
    );
  }
});

test("natural expiry closure must fit the issued deadline and its one-second close grace", async () => {
  const { sessionCloseCheckpoint, expectSilentSessionClose } = await load();
  for (const expiresAt of [undefined, NaN, 400, 2100]) {
    const client = fixture();
    client.event.reason = "caller_context_expired";
    const before = { ...sessionCloseCheckpoint(client, () => 100), expiresAt };
    await assert.rejects(
      expectSilentSessionClose(client, before, "expired", "prompt", {}),
    );
  }
});

test("short-session expiry uses the whole-second CCT cap and keeps both deadlines", async () => {
  const { sessionCloseCheckpoint, expectSilentSessionClose } = await load();
  const client = fixture();
  client.event.reason = "caller_context_expired";
  client.event.at = 1100;
  const before = {
    ...sessionCloseCheckpoint(client, () => 100),
    expiresAt: 2250,
  };
  const result = await expectSilentSessionClose(
    client,
    before,
    "expired",
    "prompt",
    {},
  );
  assert.equal(result.expiresAt, 2250);
  assert.equal(result.derivedCCTExpiresAt, 2000);
  for (const patch of [
    { at: 999 },
    { at: 2001 },
    { reason: "identity_unavailable" },
  ]) {
    Object.assign(
      client.event,
      { at: 1100, reason: "caller_context_expired" },
      patch,
    );
    await assert.rejects(
      expectSilentSessionClose(client, before, "expired", "prompt", {}),
    );
  }
});
