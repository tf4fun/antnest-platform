import assert from "node:assert/strict";
import test from "node:test";
import { publishAutomaticRecoveryCheckpoint } from "./automatic-recovery-capture.mjs";

function fixture() {
  const files = new Map(),
    abort = new AbortController();
  const adapter = {
    async writeFile(path, text) {
      files.set(path, text);
    },
    async chmod() {},
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    async rm(path) {
      files.delete(path);
    },
  };
  return {
    files,
    abort,
    adapter,
    path: "/owned/recovery-1.json",
    snapshot: { original: "receipt" },
  };
}

test("checkpoint publication refuses cancellation before writing any success evidence", async () => {
  const f = fixture(),
    reason = new Error("cancel before publication");
  f.abort.abort(reason);
  await assert.rejects(
    publishAutomaticRecoveryCheckpoint(f.path, f.snapshot, {
      signal: f.abort.signal,
      files: f.adapter,
    }),
    (error) => error === reason,
  );
  assert.equal(f.files.size, 0);
});

test("cancellation joins a held checkpoint write and removes its partial file", async () => {
  const f = fixture(),
    entered = Promise.withResolvers(),
    released = Promise.withResolvers();
  const reason = new Error("cancel held write");
  f.adapter.writeFile = async (path, text) => {
    f.files.set(path, text);
    entered.resolve();
    await released.promise;
  };
  let settled = false;
  const task = publishAutomaticRecoveryCheckpoint(f.path, f.snapshot, {
    signal: f.abort.signal,
    files: f.adapter,
  });
  const checked = assert
    .rejects(task, (error) => error === reason)
    .finally(() => {
      settled = true;
    });
  try {
    await entered.promise;
    f.abort.abort(reason);
    await Promise.resolve();
    assert.equal(settled, false, "pending write must be joined");
  } finally {
    released.resolve();
  }
  await checked;
  assert.equal(f.files.size, 0);
});

test("cancellation at rename removes published evidence and cannot return success", async () => {
  const f = fixture(),
    original = f.adapter.rename,
    reason = new Error("cancel publication");
  f.adapter.rename = async (...args) => {
    await original(...args);
    f.abort.abort(reason);
  };
  await assert.rejects(
    publishAutomaticRecoveryCheckpoint(f.path, f.snapshot, {
      signal: f.abort.signal,
      files: f.adapter,
    }),
    (error) => error === reason,
  );
  assert.equal(f.files.size, 0);
});

test("successful publication retains exactly the original snapshot with no temporary file", async () => {
  const f = fixture();
  await publishAutomaticRecoveryCheckpoint(f.path, f.snapshot, {
    signal: f.abort.signal,
    files: f.adapter,
  });
  assert.deepEqual([...f.files], [[f.path, JSON.stringify(f.snapshot)]]);
});
