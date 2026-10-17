import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { observeStream } from "./transport.mjs";

const url = new URL("./notification-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const binding = {
  agentId: "agent",
  version: 1,
  connectionTraceID: "a".repeat(32),
  clientSpanID: "b".repeat(16),
};
function recorder() {
  assert.equal(typeof implementation.createNotificationEvidence, "function");
  return implementation.createNotificationEvidence(binding);
}
function sender(evidence, write) {
  return (method, params) =>
    evidence.write({ jsonrpc: "2.0", method, params }, write);
}

test("notification evidence binds a private copy to the actual held write without retaining payload", async () => {
  const evidence = recorder();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let wire;
  const params = {
    sessionId: "original-session",
    _meta: { canary: "PRIVATE-PARAMS" },
  };
  const sending = evidence.notify(
    "session/cancel",
    params,
    sender(evidence, async (message) => {
      entered.resolve();
      await release.promise;
      wire = JSON.parse(JSON.stringify(message));
    }),
  );
  try {
    await entered.promise;
    assert.equal(evidence.snapshot()[0].status, "writing");
    params.sessionId = "mutated-session";
    params._meta.canary = "CHANGED-PARAMS";
    assert(!Object.isFrozen(params));
    release.resolve();
    assert.equal(await sending, undefined);
    assert.equal(wire.params.sessionId, "original-session");
    assert.equal(wire.params._meta.canary, "PRIVATE-PARAMS");
    assert.equal(Object.hasOwn(wire, "id"), false);
    const receipts = evidence.snapshot();
    assert.deepEqual(receipts, [
      {
        ...binding,
        index: 0,
        method: "session/cancel",
        sessionId: "original-session",
        origin: "notify",
        status: "write_completed",
        wireObserved: true,
        writeOutcome: "completed",
      },
    ]);
    assert(Object.isFrozen(receipts));
    assert(Object.isFrozen(receipts[0]));
    assert.throws(() => {
      receipts[0].sessionId = "wrong";
    }, TypeError);
    assert(!JSON.stringify(receipts).includes("PARAMS"));
    evidence.stop();
    await evidence.join();
    assert.equal(evidence.pending, 0);
  } finally {
    release.resolve();
    await sending.catch(() => {});
  }
});

test("same-session concurrent notifications keep distinct attempts even when writes settle out of order", async () => {
  const evidence = recorder();
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let count = 0;
  const send = sender(evidence, () =>
    ++count === 1 ? first.promise : second.promise,
  );
  const a = evidence.notify("session/cancel", { sessionId: "s" }, send);
  const b = evidence.notify("session/cancel", { sessionId: "s" }, send);
  try {
    second.resolve();
    await b;
    assert.deepEqual(
      evidence.snapshot().map((r) => [r.index, r.status]),
      [
        [0, "writing"],
        [1, "write_completed"],
      ],
    );
    first.resolve();
    await a;
    assert.deepEqual(
      evidence.snapshot().map((r) => r.status),
      ["write_completed", "write_completed"],
    );
    evidence.stop();
    await evidence.join();
  } finally {
    first.resolve();
    second.resolve();
    await Promise.allSettled([a, b]);
  }
});

for (const entered of [false, true])
  test(`notification failure ${entered ? "inside" : "before"} write retains its original rejection and no payload in the receipt`, async () => {
    const evidence = recorder();
    const failure = new Error("PRIVATE-ERROR-CANARY");
    await evidence.notify(
      "session/cancel",
      { sessionId: "ok" },
      sender(evidence, async () => {}),
    );
    const reject = async () => {
      throw failure;
    };
    const send = entered ? sender(evidence, reject) : reject;
    await assert.rejects(
      evidence.notify("session/cancel", { sessionId: "failed" }, send),
      (error) => error === failure,
    );
    const receipts = evidence.snapshot();
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].status, "write_completed");
    assert.equal(receipts[1].status, "failed");
    assert.equal(receipts[1].wireObserved, entered);
    assert.equal(receipts[1].writeOutcome, entered ? "failed" : null);
    assert(!JSON.stringify(receipts).includes("CANARY"));
    evidence.stop();
    await assert.rejects(evidence.join(), (error) =>
      error.errors.includes(failure),
    );
    assert.equal(evidence.pending, 0);
  });

test("close joins an entered write and a queued SDK notification; neither can later become a success", async () => {
  const evidence = recorder();
  const held = Promise.withResolvers();
  const queued = Promise.withResolvers();
  let forwarded = 0;
  const write = async () => {
    forwarded++;
    await held.promise;
  };
  const first = evidence.notify(
    "session/cancel",
    { sessionId: "s" },
    sender(evidence, write),
  );
  const second = evidence.notify(
    "session/cancel",
    { sessionId: "s" },
    async (method, params) => {
      await queued.promise;
      return evidence.write({ jsonrpc: "2.0", method, params }, write);
    },
  );
  void first.catch(() => {});
  void second.catch(() => {});
  evidence.stop();
  let joined = false;
  const joining = evidence.join().finally(() => {
    joined = true;
  });
  void joining.catch(() => {});
  try {
    await turn();
    assert.equal(joined, false);
    assert.deepEqual(
      evidence.snapshot().map((r) => r.status),
      ["closed_during_write", "closed_before_write"],
    );
    held.resolve();
    queued.resolve();
    await assert.rejects(first);
    await assert.rejects(second);
    await assert.rejects(joining);
    assert.equal(forwarded, 1);
    assert.equal(evidence.pending, 0);
    assert.deepEqual(
      evidence.snapshot().map((r) => r.status),
      ["closed_during_write", "closed_before_write"],
    );
    assert.equal(evidence.snapshot()[0].writeOutcome, "completed");
    let called = false;
    await assert.rejects(
      evidence.notify("session/cancel", { sessionId: "late" }, () => {
        called = true;
      }),
    );
    assert.equal(called, false);
    assert.equal(evidence.snapshot().at(-1).status, "closed_before_write");
  } finally {
    held.resolve();
    queued.resolve();
    await Promise.allSettled([first, second, joining]);
  }
});

test("an SDK notification resolved without reaching the actual observer is not evidence of a send", async () => {
  const evidence = recorder();
  await assert.rejects(
    evidence.notify("session/cancel", { sessionId: "s" }, async () => {}),
    /write receipt missing/,
  );
  assert.equal(evidence.snapshot()[0].status, "failed");
  assert.equal(evidence.snapshot()[0].wireObserved, false);
  evidence.stop();
  await assert.rejects(evidence.join());
});

test("the stream observer records actual notifications and leaves request and response identities intact", async () => {
  const evidence = recorder();
  const wire = [],
    requests = [];
  const source = {
    readable: new ReadableStream(),
    writable: new WritableStream({ write: (message) => wire.push(message) }),
  };
  const stream = observeStream(source, requests, undefined, evidence);
  const writer = stream.writable.getWriter();
  const request = {
    jsonrpc: "2.0",
    id: 12,
    method: "session/prompt",
    params: { sessionId: "s" },
  };
  const response = { jsonrpc: "2.0", id: 13, result: {} };
  try {
    await writer.write(request);
    await evidence.notify(
      "session/cancel",
      { sessionId: "s" },
      (method, params) => writer.write({ jsonrpc: "2.0", method, params }),
    );
    await writer.write(response);
    await writer.write({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 12 },
    });
    await writer.close();
    assert.strictEqual(wire[0], request);
    assert.strictEqual(wire[2], response);
    assert.deepEqual(requests, [
      { requestId: "12", method: "session/prompt", sessionId: "s" },
    ]);
    assert.deepEqual(
      evidence.snapshot().map(({ origin, method, wireObserved, status }) => ({
        origin,
        method,
        wireObserved,
        status,
      })),
      [
        {
          origin: "notify",
          method: "session/cancel",
          wireObserved: true,
          status: "write_completed",
        },
        {
          origin: "sdk",
          method: "notifications/cancelled",
          wireObserved: true,
          status: "write_completed",
        },
      ],
    );
    evidence.stop();
    await evidence.join();
  } finally {
    writer.releaseLock();
    await source.readable.cancel();
  }
});
