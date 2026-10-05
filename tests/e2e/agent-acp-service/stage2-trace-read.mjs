import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { traceTopology } from "../observability/trace-tree.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";

export function reviewStage2Trace(trace) {
  traceTopology(trace);
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((span) => span.warnings ?? []),
  ];
  const review = {
    trace_id: trace.traceID,
    strict_trace: warnings.length ? "failed" : "passed",
    warning_count: warnings.length,
    warnings,
  };
  assert(clockWarningsOnly([review]), "unreviewed Jaeger warnings");
  return review;
}

export async function waitForTraceParents(
  read,
  { timeout = 15000, interval = 200 } = {},
) {
  const signal = AbortSignal.timeout(timeout);
  let pending;
  try {
    while (true) {
      signal.throwIfAborted();
      const trace = await read(signal);
      signal.throwIfAborted();
      if (trace !== null) {
        assert(
          trace?.traceID && Array.isArray(trace.spans),
          "invalid Jaeger trace",
        );
        const ids = new Set(trace.spans.map((span) => span.spanID));
        const missing = trace.spans.flatMap((span) =>
          (span.references ?? [])
            .filter(
              (ref) =>
                ref.refType === "CHILD_OF" &&
                ref.traceID === trace.traceID &&
                !ids.has(ref.spanID),
            )
            .map((ref) => ({
              child: span.spanID,
              name: span.operationName,
              parent: ref.spanID,
            })),
        );
        if (trace.spans.length && !missing.length) return trace;
        pending = {
          trace_id: trace.traceID,
          spans: trace.spans.length,
          missing,
        };
      }
      await delay(interval, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted && pending)
      throw new Error(`incomplete Jaeger trace: ${JSON.stringify(pending)}`, {
        cause: error,
      });
    throw error;
  }
}
