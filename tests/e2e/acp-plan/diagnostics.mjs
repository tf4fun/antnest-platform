import assert from "node:assert/strict";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import {
  collectPrivatePlanTrace,
  privatePlanStrictOutcome,
} from "./collector.mjs";

// Runtime inspection and all business/cleanup work stay with the caller.
// A missing diagnostic keeps its position without inventing a Trace or Run.
export async function collectPlanTraceDiagnostics(
  base,
  inventory,
  options = {},
) {
  const {
    collectRequest = collectPrivatePlanTrace,
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
  for (const [index, expected] of requests.entries()) {
    options.signal?.throwIfAborted();
    const diagnostic = await diagnostics.run(
      `plan-request-${index}`,
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
  await diagnostics.run("plan-trace-inventory", () => {
    assert.equal(
      new Set((options.requests ?? []).map((request) => request.trace_id)).size,
      inventory.executionRequests.length,
      "one independent execution trace per prompt",
    );
    const start = inventory.setupRequests.length,
      end = start + inventory.executionRequests.length,
      traces = checked.slice(start, end),
      replays = checked.slice(end, 40),
      auxiliary = checked.slice(40);
    assert.equal(checked.length, 54);
    assert(checked.every((row) => row?.trace_id));
    assert.equal(
      new Set(checked.slice(0, 40).map((trace) => trace.trace_id)).size,
      40,
    );
    assert.deepEqual(
      new Set(traces.map((trace) => trace.trace_id)),
      new Set((options.requests ?? []).map((request) => request.trace_id)),
    );
    assert(traces.every((trace) => trace.run_id));
    assert.equal(
      new Set(traces.map((trace) => trace.run_id)).size,
      inventory.executionRequests.length,
    );
    assert.equal(
      traces.reduce((sum, trace) => sum + trace.runtime_tool_calls, 0),
      2,
    );
    assert.equal(replays.length, 26);
    assert.equal(replays.filter((trace) => !trace.denial).length, 20);
    assert.equal(replays.filter((trace) => trace.denial).length, 6);
    assert.equal(auxiliary.length, 14);
  });
  let strict = { strict_trace: "failed", accepted: false, exit_code: 1 };
  await diagnostics.run("plan-strict-trace-result", () => {
    strict = privatePlanStrictOutcome(checked);
    assert.equal(
      strict.exit_code,
      0,
      "original strict Trace findings retained as auxiliary diagnostics",
    );
  });
  options.signal?.throwIfAborted();
  return { checked, strict, trace_diagnostics: diagnostics.summary() };
}
