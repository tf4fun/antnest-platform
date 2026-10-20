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

test("parse cancellation starts SSE immediately but defers Runtime sampling until the original write completes", async () => {
  const written = Promise.withResolvers(),
    response = Promise.withResolvers();
  const started = [];
  let settled = false;
  const result = client
    .observeCapacityCancellation(
      {
        cancel: async () => {
          started.push("cancel");
          await response.promise;
          return "original response";
        },
        quiescent: () => {
          started.push("quiescent");
          return "complete Runtime receipt";
        },
        terminal: () => {
          started.push("terminal");
          return "original SSE receipt";
        },
      },
      { cancellationWritten: written.promise },
    )
    .finally(() => {
      settled = true;
    });
  try {
    await nextTurn();
    assert.deepEqual(started, ["cancel", "terminal"]);
    assert.equal(settled, false);
    written.resolve();
    await nextTurn();
    assert.deepEqual(started, ["cancel", "terminal", "quiescent"]);
    assert.equal(settled, false, "the HTTP response must still be joined");
  } finally {
    written.resolve();
    response.resolve();
  }
  assert.deepEqual(await result, {
    cancel: "original response",
    quiescent: "complete Runtime receipt",
    terminal: "original SSE receipt",
  });
});

test("a rejected original write does not sample Runtime and joins the original SSE waiter before retaining the error", async () => {
  const written = Promise.withResolvers(),
    terminal = Promise.withResolvers();
  const failure = new Error("original cancellation write failed");
  const started = [];
  let settled = false;
  const result = client
    .observeCapacityCancellation(
      {
        cancel: () => {
          started.push("cancel");
        },
        quiescent: () => {
          started.push("quiescent");
        },
        terminal: async () => {
          started.push("terminal");
          await terminal.promise;
        },
      },
      { cancellationWritten: written.promise },
    )
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
  void written.promise.catch(() => {});
  try {
    await nextTurn();
    written.reject(failure);
    await nextTurn();
    assert.deepEqual(started, ["cancel", "terminal"]);
    assert.equal(settled, false, "the SSE waiter must still be joined");
  } finally {
    written.reject(failure);
    terminal.resolve();
  }
  assert.equal(await result, failure);
});
