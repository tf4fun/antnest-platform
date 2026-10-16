import assert from "node:assert/strict";

// Apply these source invariants even when initialize has no application or SQL
// spans. Binding parameters and result rows are never evidence for Cost traces.
export function assertCostTraceSource(...sources) {
  for (const source of sources.filter(Boolean)) {
    assert(Array.isArray(source.spans));
    for (const span of source.spans) {
      assert(
        Number.isFinite(span.startTime) &&
          Number.isFinite(span.duration) &&
          span.duration >= 0 &&
          Number.isFinite(span.startTime + span.duration),
        "unfinished or invalid Cost source span",
      );
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((event) => event.fields ?? []),
      ])
        for (const { key } of fields) {
          assert(
            key !== "antnest.payload.json",
            "Cost source captured payload",
          );
          assert(
            !["pgx.query.parameters", "db.connection_string"].includes(key) &&
              !/^db\.(query\.parameters?|query\.results?|statement\.parameters)(\.|$)/u.test(
                key,
              ),
            "Cost source captured SQL parameters/results or connection string",
          );
        }
    }
  }
}
