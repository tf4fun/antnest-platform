import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { observeStream, observeFetch } from "./transport.mjs";

test("WebSocket observer records actual SDK IDs without changing messages or retaining payloads", async () => {
  const sent = [],
    observed = [];
  let closed = false;
  const source = {
    readable: new ReadableStream(),
    writable: new WritableStream({
      write: (m) => sent.push(m),
      close: () => {
        closed = true;
      },
    }),
  };
  const stream = observeStream(source, observed);
  assert.equal(stream.readable, source.readable);
  const writer = stream.writable.getWriter();
  const request = {
    jsonrpc: "2.0",
    id: 47,
    method: "session/prompt",
    params: { sessionId: "session", prompt: [{ text: "PRIVATE" }] },
  };
  await writer.write(request);
  await writer.write({ jsonrpc: "2.0", id: 9, result: {} });
  await writer.close();
  assert.equal(sent[0], request);
  assert.equal(closed, true);
  assert.deepEqual(observed, [
    { requestId: "47", method: "session/prompt", sessionId: "session" },
  ]);
});

test("opt-in incoming frames retain pre-SDK copies without changing either stream", async () => {
  const originals = [
    { jsonrpc: "2.0", id: 1, result: { _meta: { receipt: "PRIVATE" } } },
    { jsonrpc: "2.0", id: 2, error: { code: -32020, data: { private: true } } },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { measurement: { pricing: "PRIVATE" } },
      },
    },
  ];
  const expected = structuredClone(originals);
  const frames = [],
    observed = [],
    sent = [];
  const stream = observeStream(
    {
      readable: new ReadableStream({
        start(controller) {
          for (const frame of originals) controller.enqueue(frame);
          controller.close();
        },
      }),
      writable: new WritableStream({ write: (message) => sent.push(message) }),
    },
    observed,
    frames,
  );
  const received = [];
  for await (const frame of stream.readable) received.push(frame);
  assert.deepEqual(frames, expected);
  for (const [index, frame] of received.entries()) {
    assert.strictEqual(frame, originals[index]);
    assert.notStrictEqual(frames[index], frame);
  }
  frames[0].result._meta.receipt = "consumer mutation";
  received[2].params.update.measurement.pricing = "SDK mutation";
  assert.equal(received[0].result._meta.receipt, "PRIVATE");
  assert.equal(frames[2].params.update.measurement.pricing, "PRIVATE");
  const request = {
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId: "s", prompt: [{ text: "PRIVATE" }] },
  };
  const writer = stream.writable.getWriter();
  await writer.write(request);
  await writer.close();
  assert.strictEqual(sent[0], request);
  assert.deepEqual(observed, [
    { requestId: "3", method: "session/prompt", sessionId: "s" },
  ]);
});

test("raw capture reads only when its consumer requests the next frame", async () => {
  let pulls = 0;
  const source = new ReadableStream(
    {
      pull(controller) {
        controller.enqueue({ jsonrpc: "2.0", id: ++pulls, result: {} });
      },
    },
    { highWaterMark: 0 },
  );
  const frames = [];
  const stream = observeStream(
    { readable: source, writable: new WritableStream() },
    [],
    frames,
  );
  const reader = stream.readable.getReader();
  try {
    await turn();
    assert.equal(
      pulls,
      0,
      "capture must not independently drain incoming frames",
    );
    assert.deepEqual(frames, []);
    assert.equal((await reader.read()).value.id, 1);
    await turn();
    assert.equal(pulls, 1, "capture must preserve consumer backpressure");
    assert.equal(frames.length, 1);
  } finally {
    await reader.cancel();
    reader.releaseLock();
    await stream.writable.abort();
  }
  assert.equal(source.locked, false);
});

for (const rejectCancellation of [false, true])
  test(
    "raw capture joins upstream cancellation and preserves its " +
      (rejectCancellation ? "failure" : "reason"),
    { timeout: 2000 },
    async () => {
      const pulled = Promise.withResolvers();
      const cancelling = Promise.withResolvers();
      const cleanup = Promise.withResolvers();
      const reason = new Error("consumer cancelled a pending read");
      const cleanupError = new Error("actual upstream cancel failed");
      let actualReason,
        cancelCalls = 0;
      const source = new ReadableStream({
        pull() {
          pulled.resolve();
        },
        cancel(received) {
          actualReason = received;
          cancelCalls++;
          cancelling.resolve();
          return cleanup.promise;
        },
      });
      const frames = [];
      const stream = observeStream(
        { readable: source, writable: new WritableStream() },
        [],
        frames,
      );
      const reader = stream.readable.getReader();
      const reading = reader.read();
      await pulled.promise;
      let settled = false;
      const cancelled = reader.cancel(reason).finally(() => {
        settled = true;
      });
      void cancelled.catch(() => {});
      try {
        await cancelling.promise;
        assert.deepEqual(await reading, { value: undefined, done: true });
        await turn();
        assert.equal(
          settled,
          false,
          "cancellation must join actual upstream cleanup",
        );
        assert.strictEqual(actualReason, reason);
        assert.equal(cancelCalls, 1);
        assert.deepEqual(frames, []);
        if (rejectCancellation) {
          cleanup.reject(cleanupError);
          await assert.rejects(cancelled, (error) => error === cleanupError);
        } else {
          cleanup.resolve();
          await cancelled;
        }
      } finally {
        cleanup.resolve();
        await cancelled.catch(() => {});
        reader.releaseLock();
        await stream.writable.abort();
      }
      assert.equal(source.locked, false);
    },
  );

test("raw capture propagates an upstream read failure and releases its reader", async () => {
  const reason = new Error("actual incoming transport failed");
  const source = new ReadableStream({
    pull(controller) {
      controller.error(reason);
    },
  });
  const frames = [];
  const stream = observeStream(
    { readable: source, writable: new WritableStream() },
    [],
    frames,
  );
  const reader = stream.readable.getReader();
  await assert.rejects(reader.read(), (error) => error === reason);
  reader.releaseLock();
  assert.equal(source.locked, false);
  assert.deepEqual(frames, []);
  await stream.writable.abort();
});

for (const frames of [null, true, {}])
  test(`invalid raw frame destination ${JSON.stringify(frames)} cannot lock the transport`, () => {
    const stream = {
      readable: new ReadableStream(),
      writable: new WritableStream(),
    };
    assert.throws(() => observeStream(stream, [], frames));
    assert.equal(stream.readable.locked, false);
    assert.equal(stream.writable.locked, false);
  });

test("HTTP observer records the Gateway response trace per POST and preserves SDK transport", async () => {
  const observed = [],
    sent = [];
  const fetch = observeFetch(async (url, init) => {
    sent.push({ url, init });
    return new Response("{}", {
      status: 202,
      headers: { "X-Antnest-Trace-ID": String(sent.length).padStart(32, "0") },
    });
  }, observed);
  const init = {
    method: "POST",
    headers: { Cookie: "synthetic" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "actual",
      method: "session/new",
      params: { private: "PRIVATE" },
    }),
  };
  assert.equal((await fetch("http://fixture", init)).status, 202);
  await fetch("http://fixture", { method: "GET" });
  assert.equal(sent[0].init, init);
  assert.deepEqual(observed, [
    {
      requestId: "actual",
      method: "session/new",
      sessionId: undefined,
      traceID: "00000000000000000000000000000001",
    },
  ]);
  await assert.rejects(
    observeFetch(async () => new Response("{}"), [])("http://fixture", init),
  );
});
