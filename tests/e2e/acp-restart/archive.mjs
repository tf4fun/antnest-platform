import assert from "node:assert/strict";
export async function archiveCompleted(requests, cache, collect) {
  for (const request of requests) {
    if (request.kind === "interruption") continue;
    assert.equal(typeof request.label, "string");
    if (cache.has(request.label)) {
      assert.deepEqual(
        cache.get(request.label).request,
        request,
        "archive label reused for another request",
      );
      continue;
    }
    const trace = await collect(request);
    assert(trace, "missing completed request trace");
    cache.set(request.label, { request: structuredClone(request), trace });
  }
}
