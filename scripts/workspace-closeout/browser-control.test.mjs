import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import test from "node:test";
import { waitForFinish, assertWorkspaceBytes } from "./browser-control.mjs";

test("input EOF aborts startup immediately, without waiting for readiness", async () => {
  for (const stage of ["configuration", "compose", "agent_create"]) {
    const input = new EventEmitter(),
      abort = new AbortController();
    const finished = waitForFinish(input, abort);
    input.emit("close");
    assert(abort.signal.aborted, stage);
    await assert.rejects(finished, /input closed/);
    assert.equal(input.listenerCount("line"), 0);
  }
});

test("finish completes once and releases input and abort listeners", async () => {
  const input = new EventEmitter(),
    abort = new AbortController();
  const finished = waitForFinish(input, abort);
  input.emit("line", "finish");
  await finished;
  input.emit("close");
  assert(!abort.signal.aborted);
  assert.equal(input.listenerCount("close"), 0);
});

test("unexpected commands and interruption never count as finish", async () => {
  for (const action of ["invalid", "abort"]) {
    const input = new EventEmitter(),
      abort = new AbortController();
    const finished = waitForFinish(input, abort);
    if (action === "abort") abort.abort();
    else input.emit("line", "pass");
    await assert.rejects(finished);
    assert(abort.signal.aborted);
  }
});

test("workspace mismatch fails without exposing actual bytes in error output", () => {
  const secret = "PRIVATE_FILE_CONTENT";
  assert.throws(
    () => assertWorkspaceBytes(Buffer.from(secret).toString("base64")),
    (error) => {
      assert(!inspect(error).includes(secret));
      return /workspace write duplicated or lost/.test(error.message);
    },
  );
  assertWorkspaceBytes(
    Buffer.from("C4_BROWSER_NOTE=alpha-beta\n").toString("base64"),
  );
});
