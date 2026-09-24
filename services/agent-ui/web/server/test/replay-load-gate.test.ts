import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplayLoadGate } from "../src/bridge/replay-load-gate.ts";
import { HistoryCapacityError } from "../src/bridge/compact-transcript.ts";

test("a failed replay releases the slot for the next queued Session", async () => {
  const gate = new ReplayLoadGate(1);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const first = gate.run(async () => {
    calls.push("first");
    await pending;
    throw new Error("ACP replay failed");
  });
  const second = gate.run(async () => {
    calls.push("second");
    return "recovered";
  });
  assert.deepEqual(calls, ["first"]);
  finish();
  await assert.rejects(first, /ACP replay failed/);
  assert.equal(await second, "recovered");
  assert.deepEqual(calls, ["first", "second"]);
});

test("replay admission reports only active and queued loads", async () => {
  const gate = new ReplayLoadGate(1);
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const firstHold = new Promise<void>((resolve) => { finishFirst = resolve; });
  const secondHold = new Promise<void>((resolve) => { finishSecond = resolve; });
  const first = gate.run(() => firstHold);
  assert.deepEqual(gate.snapshotMetrics(), { active: 1, queued: 0 });
  const second = gate.run(() => secondHold);
  assert.deepEqual(gate.snapshotMetrics(), { active: 1, queued: 1 });
  await assert.rejects(gate.run(async () => {}), HistoryCapacityError);
  assert.deepEqual(gate.snapshotMetrics(), { active: 1, queued: 1 });
  finishFirst();
  await first;
  assert.deepEqual(gate.snapshotMetrics(), { active: 1, queued: 0 });
  finishSecond();
  await second;
  assert.deepEqual(gate.snapshotMetrics(), { active: 0, queued: 0 });
});
