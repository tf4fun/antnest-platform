import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

const url = new URL(
  "./resolve-cache-outage-diagnostics-flow.mjs",
  import.meta.url,
);
const { collectOutageDiagnostics: collect } = await import(url).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  },
);

function fixture(t) {
  assert.equal(typeof collect, "function");
  const output = mkdtempSync(
    join(temporaryStorageRoot(), "outage-diagnostic-test-"),
  );
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const controller = new AbortController();
  return {
    evidence: { business_window: { run_id: "original-run" } },
    signal: controller.signal,
    controller,
    diagnostics: createTraceDiagnostics({
      directory: output,
      signal: controller.signal,
      budgetMs: 1000,
    }),
  };
}

test("outage collector failure is retained without rewriting original business evidence", async (t) => {
  const f = fixture(t),
    before = structuredClone(f.evidence);
  const result = await collect(f, {
    archive: async () => {
      throw new Error("collector unavailable");
    },
    admit: () => assert.fail("missing archive cannot be admitted"),
  });
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.diagnostic.status, "failed");
  assert.equal(result.trace_evidence, undefined);
  assert.deepEqual(f.evidence, before);
});

test("outage owning or strict diagnostics retain raw archive without blocking business", async (t) => {
  const f = fixture(t),
    raw = {
      status: "owning_admission_passed",
      strict_trace: "failed",
      reports: [{ raw: "retained" }],
    };
  const result = await collect(f, {
    archive: async () => raw,
    admit: () => {},
  });
  assert.equal(result.trace_evidence, raw);
  assert.equal(result.trace_diagnostics.status, "warning");
});

test("outage diagnostic waits for collector cleanup after parent interruption", async (t) => {
  const f = fixture(t);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let joined = false,
    finished = false;
  const result = collect(f, {
    archive: async (signal) => {
      entered.resolve(signal);
      await release.promise;
      joined = true;
      signal.throwIfAborted();
    },
    admit: () => {},
  });
  result.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  const signal = await entered.promise;
  f.controller.abort(new Error("interrupted"));
  await Promise.resolve();
  assert.equal(signal.aborted, true);
  assert.equal(finished, false);
  release.resolve();
  await assert.rejects(result, /interrupted/u);
  assert.equal(joined, true);
});
