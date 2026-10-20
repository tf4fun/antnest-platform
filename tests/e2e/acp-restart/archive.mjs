import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
export async function archiveCompleted(
  requests,
  cache,
  collect,
  { initializations = [], signal } = {},
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
    const report = await collect(request);
    signal?.throwIfAborted();
    assert(report?.trace_id, "missing completed request trace report");
    cache.set(request.label, {
      request: structuredClone(request),
      report: structuredClone(report),
    });
  }
}
