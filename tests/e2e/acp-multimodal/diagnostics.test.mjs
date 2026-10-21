import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = new URL("./diagnostics.mjs", import.meta.url);
const { collectNativeTraceDiagnostics: collect } = await import(url).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  },
);
function fixture(t) {
  assert.equal(typeof collect, "function");
  const directory = mkdtempSync(join(tmpdir(), "antnest-native-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const rows = Array.from({ length: 60 }, (_, i) => ({
    label: `request-${i}`,
    kind: i < 9 ? "native" : i < 12 ? "local-failure" : "request",
  }));
  return {
    directory,
    rows,
    inventory: { requests: rows.slice(0, 48), initializations: rows.slice(48) },
    models: rows.slice(0, 9).map((r) => ({ trace_id: r.label })),
  };
}
function raw(expected, rows) {
  const index = rows.indexOf(expected);
  return {
    trace_id: expected.label,
    kind: expected.kind,
    ...(index < 12 ? { run_id: `run-${index}` } : {}),
    diagnostic_inventory_verified: true,
    raw_error_inventory: [],
    owned_error_spans: [],
    error_spans: 0,
    warning_count: 0,
    warnings: [],
    strict_trace: "passed",
  };
}
test("Native diagnostics retain all 60 original positions and the 12 Run inventory", async (t) => {
  const f = fixture(t);
  const result = await collect("http://jaeger.invalid", f.inventory, {
    directory: f.directory,
    requests: f.models,
    collectRequest: async (_base, expected, options) => {
      assert(options.signal instanceof AbortSignal);
      return raw(expected, f.rows);
    },
  });
  assert.equal(result.checked.length, 60);
  assert.equal(result.strict.exit_code, 0);
  assert.equal(result.trace_diagnostics.status, "passed");
});
test("Native collector failure remains auxiliary and cannot invent a replacement Trace or Run", async (t) => {
  const f = fixture(t),
    calls = [];
  const result = await collect("http://jaeger.invalid", f.inventory, {
    directory: f.directory,
    requests: f.models,
    collectRequest: async (_base, expected) => {
      calls.push(expected.label);
      if (expected === f.rows[0]) throw new Error("owning inspector failed");
      return raw(expected, f.rows);
    },
  });
  assert.deepEqual(
    calls,
    f.rows.map((r) => r.label),
  );
  assert.deepEqual(Object.keys(result.checked[0]).sort(), [
    "diagnostic",
    "label",
  ]);
  assert.equal(result.checked[0].label, f.rows[0].label);
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.strict.exit_code, 1);
});
test("exhausted Native diagnostic budget retains every position without invoking a collector", async (t) => {
  const f = fixture(t);
  const result = await collect("http://jaeger.invalid", f.inventory, {
    directory: f.directory,
    budgetMs: 0,
    requests: f.models,
    collectRequest: () => assert.fail("budget exhausted"),
  });
  assert.equal(result.checked.length, 60);
  assert(result.checked.every((r) => r.diagnostic.status === "not_collected"));
  assert.equal(result.trace_diagnostics.status, "warning");
});
test("Native raw strict failure stays failed while producing an auxiliary warning", async (t) => {
  const f = fixture(t);
  const result = await collect("http://jaeger.invalid", f.inventory, {
    directory: f.directory,
    requests: f.models,
    collectRequest: async (_base, expected) => ({
      ...raw(expected, f.rows),
      warning_count: 1,
      warnings: [
        "clock skew adjustment disabled; not applying calculated delta of -2ms",
      ],
      strict_trace: "failed",
    }),
  });
  assert.equal(result.strict.strict_trace, "failed");
  assert.equal(result.strict.exit_code, 2);
  assert.equal(result.trace_diagnostics.status, "warning");
});
test("missing or repeated model Trace IDs only change the diagnostic inventory", async (t) => {
  const f = fixture(t);
  const result = await collect("http://jaeger.invalid", f.inventory, {
    directory: f.directory,
    requests: f.models.map(() => ({ trace_id: undefined })),
    collectRequest: async (_base, expected) => raw(expected, f.rows),
  });
  assert.equal(result.checked.length, 60);
  assert.equal(result.trace_diagnostics.status, "warning");
  assert(
    result.trace_diagnostics.checks.some(
      (row) => row.name === "native-trace-inventory" && row.status === "failed",
    ),
  );
});
test("Native parent interruption waits for the active collector to join and remains fatal", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let done = false,
    joined = false;
  const result = collect("http://jaeger.invalid", f.inventory, {
    directory: f.directory,
    requests: f.models,
    signal: controller.signal,
    collectRequest: async (_base, _expected, { signal }) => {
      entered.resolve(signal);
      await release.promise;
      joined = true;
      signal.throwIfAborted();
    },
  });
  result.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  try {
    const signal = await entered.promise;
    controller.abort(new Error("interrupted"));
    await Promise.resolve();
    assert.equal(signal.aborted, true);
    assert.equal(done, false);
    release.resolve();
    await assert.rejects(result, /interrupted/u);
    assert.equal(joined, true);
  } finally {
    controller.abort(new Error("test cleanup"));
    release.resolve();
    await result.catch(() => undefined);
  }
});
