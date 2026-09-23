import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

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
