import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { observeSocket, requestWithin } from "./connection.mjs";

class Socket extends EventEmitter {
  terminate() {
    this.emit("close", 1006);
  }
}

test("ACP fixture owns late socket errors after an HTTP upgrade rejection", async () => {
  const closed = new AbortController();
  let status,
    drained = false;
  const Observed = observeSocket(Socket, closed, (code) => {
    status = code;
  });
  const socket = new Observed();
  const pending = requestWithin(
    () => new Promise(() => {}),
    closed.signal,
    () => {},
    1000,
  );
  socket.emit(
    "unexpected-response",
    {},
    {
      statusCode: 503,
      resume() {
        drained = true;
      },
    },
  );
  socket.emit("error", new Error("late ws error"));
  await assert.rejects(pending, (error) => error.status === 503);
  assert(drained);
  assert.equal(status, 1006);
});

test("ACP fixture rejects a silent request and closes its connection once", async () => {
  const closed = new AbortController();
  let closes = 0;
  await assert.rejects(
    requestWithin(
      () => new Promise(() => {}),
      closed.signal,
      () => {
        closes++;
      },
      10,
    ),
    /timed out/,
  );
  assert.equal(closes, 1);
});

test("ACP fixture supplies SDK cancellationSignal and preserves success", async () => {
  const closed = new AbortController();
  let closes = 0;
  const value = await requestWithin(
    (options) => {
      assert(options.cancellationSignal instanceof AbortSignal);
      return "result";
    },
    closed.signal,
    () => {
      closes++;
    },
    1000,
  );
  assert.equal(value, "result");
  assert.equal(closes, 0);
});

test("ACP fixture does not invoke an already closed connection", async () => {
  const closed = new AbortController();
  closed.abort(new Error("closed before admission"));
  await assert.rejects(
    requestWithin(
      () => assert.fail("must not run"),
      closed.signal,
      () => {},
      1000,
    ),
    /closed before admission/,
  );
});
