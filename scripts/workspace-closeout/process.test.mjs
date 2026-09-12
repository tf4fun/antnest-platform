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
