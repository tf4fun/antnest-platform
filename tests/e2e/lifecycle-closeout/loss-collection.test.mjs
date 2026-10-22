import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { collectLossTraces } from "./loss-private-session.mjs";
function diagnostics(t, budgetMs) {
  const directory = mkdtempSync(join(tmpdir(), "loss-trace-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return createTraceDiagnostics({ directory, budgetMs });
}
test("Loss request collection failure stays auxiliary and later evidence is attempted", async (t) => {
  const errors = [],
    seen = [],
    preserved = [],
    rows = [{ requestId: "first" }, { requestId: "second" }];
  const result = await collectLossTraces(
    rows,
    async (row, signal) => {
      assert(signal instanceof AbortSignal);
      seen.push(row.requestId);
      if (row.requestId === "first") throw new Error("collector 503");
      return { request_id: row.requestId };
    },
    (row, error) => preserved.push([row.requestId, error.message]),
    undefined,
    errors,
    diagnostics(t, 1000),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, ["first", "second"]);
  assert.deepEqual(preserved, [["first", "collector 503"]]);
  assert.equal(result[0].topology, "failed");
  assert.equal(result[1].topology, "passed");
});
test("Loss exhausted diagnostic budget never labels an unexecuted collection passed", async (t) => {
  const errors = [];
  const result = await collectLossTraces(
    [{}],
    () => assert.fail("must not collect"),
    () => {},
    undefined,
    errors,
    diagnostics(t, 0),
  );
  assert.deepEqual(errors, []);
  assert.equal(result[0].topology, "not_collected");
});
test(
  "Loss deadline still joins the actual collector before returning",
  { timeout: 2000 },
  async (t) => {
    const errors = [];
    let release, aborted, entered, observedSignal;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const began = new Promise((resolve) => {
      aborted = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let settled = false;
    const collecting = collectLossTraces(
      [{}],
      async (_row, signal) => {
        observedSignal = signal;
        entered();
        if (!signal) return;
        signal.addEventListener("abort", aborted, { once: true });
        await hold;
      },
      () => {},
      undefined,
      errors,
      diagnostics(t, 5),
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      await started;
      assert(observedSignal instanceof AbortSignal);
      await began;
      assert.equal(settled, false);
    } finally {
      release();
      await collecting;
    }
    const result = await collecting;
    assert.deepEqual(errors, []);
    assert.equal(result[0].topology, "failed");
  },
);
