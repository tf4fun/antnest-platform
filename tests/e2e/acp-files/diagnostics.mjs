import assert from "node:assert/strict";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { inspectFileTraceMetadata } from "./file-state.mjs";
import {
  collectPrivateFileTrace,
  privateFileStrictOutcome,
} from "./collector.mjs";

// The caller owns business validation, the actual Runtime inspection and cleanup.
// These comparisons use their existing receipts only for auxiliary Trace checks.
export async function collectFileTraceDiagnostics(
  base,
  inventory,
  options = {},
) {
  const {
    collectRequest = collectPrivateFileTrace,
    diagnostics = createTraceDiagnostics(options),
  } = options;
  const checked = [];
  const requests = [
    ...inventory.setupRequests,
    ...inventory.executionRequests,
    ...inventory.replayRequests,
    ...inventory.initializationRequests,
  ];
  options.signal?.throwIfAborted();
  await diagnostics.run("files-model-trace-metadata", () =>
    inspectFileTraceMetadata(
      options.requests ?? [],
      inventory.runtimeInspection.files,
    ),
  );
  for (const [index, expected] of requests.entries()) {
    options.signal?.throwIfAborted();
    const diagnostic = await diagnostics.run(
      `files-request-${index}`,
      (signal) =>
        collectRequest(base, expected, {
          ...options,
          signal: options.signal
            ? AbortSignal.any([signal, options.signal])
            : signal,
        }),
    );
    options.signal?.throwIfAborted();
    checked.push(
      diagnostic.status === "passed"
        ? diagnostic.value
        : {
            label: expected.label ?? expected.phase ?? expected.method,
            diagnostic,
          },
    );
  }
  await diagnostics.run("files-trace-inventory", () => {
    const traces = checked.slice(18, 34),
      replays = checked.slice(34, 82),
      auxiliary = checked.slice(82);
    assert.equal(checked.length, 116);
    assert(checked.every((row) => row?.trace_id));
    assert.equal(
      new Set(checked.slice(0, 82).map((trace) => trace.trace_id)).size,
      82,
    );
    assert(traces.every((trace) => trace.run_id));
    assert.equal(new Set(traces.map((trace) => trace.run_id)).size, 16);
    assert.deepEqual(
      new Set(traces.map((trace) => trace.trace_id)),
      new Set((options.requests ?? []).map((request) => request.trace_id)),
    );
    for (const trace of traces) {
      assert.equal(trace.phases.length, 1);
      assert.equal(trace.tool_calls, 1);
      assert.equal(trace.runtime_tool_calls, 1);
      const runtime = inventory.runtimeInspection.runtimes.find(
        (row) => row.agent_id === trace.agent_id,
      );
      assert(runtime, "Files Trace belongs to an uninspected Runtime");
      assert.equal(trace.runtime_generation, String(runtime.generation));
    }
    assert.equal(replays.length, 48);
    assert.equal(auxiliary.length, 34);
  });
  let strict = { strict_trace: "failed", accepted: false, exit_code: 1 };
  await diagnostics.run("files-strict-trace-result", () => {
    strict = privateFileStrictOutcome(checked);
    assert.equal(
      strict.exit_code,
      0,
      "original strict Trace findings retained as auxiliary diagnostics",
    );
  });
  options.signal?.throwIfAborted();
  return { checked, strict, trace_diagnostics: diagnostics.summary() };
}
