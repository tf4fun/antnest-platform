import assert from "node:assert/strict";
import test from "node:test";
import { groupAlive, processStat } from "./process.mjs";

test("process evidence handles names containing spaces/parentheses and rejects corrupt records", () => {
  assert.deepEqual(processStat("42 (name ) with (spaces)) S 1 40 40 0"), {
    pid: 42,
    state: "S",
    group: 40,
  });
  assert.throws(() => processStat("42 command S 1"));
});

test("a live child prevents accepting group termination even after its parent exits", () => {
  const zombie = "40 (parent) Z 1 40 40 0";
  assert.equal(groupAlive(zombie, 40), false);
  assert.equal(groupAlive(`${zombie}\n41 (sleep) S 1 40 40 0`, 40), true);
  assert.equal(groupAlive("50 (other) R 1 50 50 0", 40), false);
  assert.throws(() => groupAlive("bad process stat", 40));
});

// Captured by the real upload-capacity suite while curl was exiting.
const exitingCurl =
  "236 (curl) X 0 -1 -1 0 -1 4227084 584 0 0 0 0 0 0 0 20 0 0 0 119682 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0 0 0 0 0 0 0 0 0";

test("process evidence accepts the signed group of an exiting process", () => {
  assert.deepEqual(processStat(exitingCurl), {
    pid: 236,
    state: "X",
    group: -1,
  });
});

test("an unrelated exiting process never hides a live member of the target group", () => {
  const zombie = "40 (parent) Z 1 40 40 0";
  const liveChild = "41 (sleep) S 1 40 40 0";
  assert.equal(groupAlive(`${exitingCurl}\n${zombie}`, 40), false);
  assert.equal(groupAlive(`${exitingCurl}\n${zombie}\n${liveChild}`, 40), true);
  assert.equal(groupAlive(`${liveChild}\n${exitingCurl}`, 40), true);
  assert.throws(() => groupAlive(`${liveChild}\nbad process stat`, 40));
  assert.throws(() => groupAlive(exitingCurl, -1));
  assert.throws(() => processStat("-236 (curl) X 0 -1 -1 0"));
  assert.throws(() => processStat("236 (curl) X 0 --1 -1 0"));
});
