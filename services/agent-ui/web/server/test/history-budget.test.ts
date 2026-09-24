import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryCapacityError } from "../src/bridge/compact-transcript.ts";
import { SharedHistoryBudget } from "../src/bridge/history-budget.ts";

test("shared history budget includes retained data and concurrent replay reservations", () => {
  const budget = new SharedHistoryBudget(100);
  const first = { estimatedCachedHistoryBytes: 40 };
  const second = { estimatedCachedHistoryBytes: 20 };
  budget.register(first);
  budget.register(second);
  assert.deepEqual(budget.snapshotMetrics(), { cachedBytes: 60, reservedBytes: 0 });
  const release = budget.reserve(first, 30);
  assert.deepEqual(budget.snapshotMetrics(), { cachedBytes: 60, reservedBytes: 30 });
  assert.throws(() => budget.reserve(second, 11), HistoryCapacityError);
  const releaseSecond = budget.reserve(second, 10);
  release();
  releaseSecond();
  assert.deepEqual(budget.snapshotMetrics(), { cachedBytes: 60, reservedBytes: 0 });
  first.estimatedCachedHistoryBytes = 70;
  assert.throws(() => budget.reserve(second, 11), HistoryCapacityError);
  budget.unregister(first);
  const releaseAfterClose = budget.reserve(second, 80);
  releaseAfterClose();
  budget.unregister(second);
  assert.deepEqual(budget.snapshotMetrics(), { cachedBytes: 0, reservedBytes: 0 });
});
