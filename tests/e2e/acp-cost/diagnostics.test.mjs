import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCostTraceDiagnostics } from "./diagnostics.mjs";

test("Cost Trace collection preserves failed positions and continues requests and pricing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-cost-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const result = await collectCostTraceDiagnostics(
    "http://jaeger:16686",
    [
      { label: "new", kind: "request" },
      { label: "prompt", kind: "native" },
      { label: "initialize", kind: "request" },
    ],
    [{ traceID: "pricing" }],
    {
      directory,
      requests: [{ trace_id: "prompt" }],
      collectRequest: async (_base, expected, options) => {
        assert(options.signal instanceof AbortSignal);
        calls.push(expected.label);
        if (expected.label === "new")
          throw new Error("same-process endpoint exceeded parent");
        return {
          trace_id: expected.label,
          ...(expected.kind === "native"
            ? { run_id: "run", kind: "native" }
            : {}),
        };
      },
      collectPricing: async (_base, expected, options) => {
        assert(options.signal instanceof AbortSignal);
        calls.push("pricing");
        return { trace_id: expected.traceID };
      },
    },
  );
  assert.deepEqual(calls, ["new", "prompt", "initialize", "pricing"]);
  assert.equal(result.checked.length, 3);
  assert.equal(result.checked[0].diagnostic.status, "failed");
  assert.equal(Object.hasOwn(result.checked[0], "trace_id"), false);
  assert.equal(result.checked[1].trace_id, "prompt");
  assert.equal(result.checked[2].trace_id, "initialize");
  assert.equal(result.pricing[0].trace_id, "pricing");
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.strict.strict_trace, "failed");
});

test("all unavailable Cost Traces cannot suppress a later business or cleanup failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-cost-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const collect = async () => {
    throw new Error("Jaeger unavailable");
  };
  const result = await collectCostTraceDiagnostics(
    "http://jaeger:16686",
    [{ label: "request" }],
    [{ traceID: "pricing" }],
    {
      directory,
      requests: [],
      collectRequest: collect,
      collectPricing: collect,
    },
  );
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.checked[0].diagnostic.status, "failed");
  assert.equal(result.pricing[0].diagnostic.status, "failed");
  const businessFailure = new Error("Runtime cleanup failed");
  await assert.rejects(
    async () => {
      throw businessFailure;
    },
    (error) => error === businessFailure,
  );
});

test("a missing Run ID remains a failed auxiliary inventory check", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-cost-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await collectCostTraceDiagnostics(
    "http://jaeger:16686",
    [
      { label: "one", kind: "native" },
      { label: "two", kind: "native" },
    ],
    [],
    {
      directory,
      requests: [{ trace_id: "one" }, { trace_id: "two" }],
      collectRequest: async (_base, expected) => ({
        trace_id: expected.label,
        kind: "native",
        ...(expected.label === "one" ? { run_id: "one" } : {}),
      }),
    },
  );
  assert.equal(
    result.trace_diagnostics.checks.find(
      (row) => row.name === "cost-trace-inventory",
    ).status,
    "failed",
  );
});
