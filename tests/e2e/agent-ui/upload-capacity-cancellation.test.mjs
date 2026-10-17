import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import * as client from "./upload-capacity-client.mjs";

test("Runtime and original SSE observation start while the cancellation HTTP response is pending", async () => {
  assert.equal(typeof client.observeCapacityCancellation, "function");
  const release = Promise.withResolvers();
  const cancel = {},
    quiescent = {},
    terminal = {};
  const started = [];
  const result = client.observeCapacityCancellation({
    cancel: async () => {
      started.push("cancel");
      await release.promise;
      return cancel;
    },
    quiescent: () => {
      started.push("quiescent");
      return Promise.resolve(quiescent);
    },
    terminal: () => {
      started.push("terminal");
      return Promise.resolve(terminal);
    },
  });
  try {
    await nextTurn();
    assert.deepEqual(started, ["cancel", "quiescent", "terminal"]);
  } finally {
    release.resolve();
  }
  const observed = await result;
  assert.equal(observed.cancel, cancel);
  assert.equal(observed.quiescent, quiescent);
  assert.equal(observed.terminal, terminal);
});

test("an HTTP failure joins the still-running Runtime observation and keeps its original error", async () => {
  assert.equal(typeof client.observeCapacityCancellation, "function");
  const release = Promise.withResolvers();
  const failure = new Error("original HTTP failure");
  let completed = false,
    joined = false;
  const result = client
    .observeCapacityCancellation({
      cancel: () => Promise.reject(failure),
      quiescent: async () => {
        await release.promise;
        joined = true;
      },
      terminal: () => Promise.resolve(),
    })
    .then(
      () => {
        completed = true;
        return undefined;
      },
      (error) => {
        completed = true;
        return error;
      },
    );
  try {
    await nextTurn();
    assert.equal(completed, false);
  } finally {
    release.resolve();
  }
  assert.equal(await result, failure);
  assert.equal(joined, true);
});

test("a synchronous branch failure still starts and joins every observer and retains all failures", async () => {
  assert.equal(typeof client.observeCapacityCancellation, "function");
  const release = Promise.withResolvers();
  const first = new Error("send failed"),
    second = new Error("process observation failed");
  const started = [];
  let settled = false;
  const result = client
    .observeCapacityCancellation({
      cancel: () => {
        started.push("cancel");
        throw first;
      },
      quiescent: () => {
        started.push("quiescent");
        return Promise.reject(second);
      },
      terminal: async () => {
        started.push("terminal");
        await release.promise;
      },
    })
    .then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
  try {
    await nextTurn();
    assert.deepEqual(started, ["cancel", "quiescent", "terminal"]);
    assert.equal(settled, false);
  } finally {
    release.resolve();
  }
  const failure = await result;
  assert(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [first, second]);
});
