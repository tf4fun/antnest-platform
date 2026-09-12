import assert from "node:assert/strict";
import { test } from "node:test";
import { publishCheckpoint } from "./checkpoint.mjs";

test("a checkpoint is published only after its complete JSON is written", async () => {
  const calls = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const files = {
    async writeFile(...args) {
      calls.push(["write", ...args]);
      await pending;
    },
    async rename(...args) {
      calls.push(["rename", ...args]);
    },
  };
  const result = publishCheckpoint(
    "/checkpoints/request-1",
    { kind: "restart" },
    files,
  );
  assert.deepEqual(calls, [
    [
      "write",
      "/checkpoints/request-1.pending",
      '{"kind":"restart"}',
      { flag: "wx" },
    ],
  ]);
  release();
  await result;
  assert.deepEqual(calls[1], [
    "rename",
    "/checkpoints/request-1.pending",
    "/checkpoints/request-1",
  ]);
});
test("failed checkpoint write cannot publish a fault request", async () => {
  let renamed = false;
  await assert.rejects(
    publishCheckpoint(
      "/checkpoints/request-1",
      {},
      {
        async writeFile() {
          throw new Error("disk full");
        },
        async rename() {
          renamed = true;
        },
      },
    ),
    /disk full/,
  );
  assert.equal(renamed, false);
});
