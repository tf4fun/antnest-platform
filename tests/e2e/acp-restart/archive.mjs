import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
export async function archiveCompleted(
  requests,
  cache,
  collect,
  { initializations = [], signal, diagnostics } = {},
) {
  signal?.throwIfAborted();
  for (const request of [...initializations, ...requests]) {
    signal?.throwIfAborted();
    if (request.kind === "interruption") continue;
    assert.equal(typeof request.label, "string");
    if (cache.has(request.label)) {
      assert(
        isDeepStrictEqual(cache.get(request.label).request, request),
        "archive label reused for another request",
      );
      continue;
    }
    let report, diagnostic;
    if (diagnostics) {
      diagnostic = await diagnostics.run(
        `restart-archive-${cache.size}`,
        async (diagnosticSignal) => {
          const value = await collect(request, { signal: diagnosticSignal });
          assert(value?.trace_id, "missing completed request trace report");
          return value;
        },
      );
      report = diagnostic.value;
    } else {
      report = await collect(request);
      assert(report?.trace_id, "missing completed request trace report");
    }
    signal?.throwIfAborted();
    cache.set(request.label, {
      request: structuredClone(request),
      report: structuredClone(report),
      ...(diagnostic ? { diagnostic } : {}),
    });
  }
}
