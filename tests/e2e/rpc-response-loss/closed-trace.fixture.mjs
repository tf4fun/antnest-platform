import { barrierTraceFixture } from "../acp-progress/control-trace.fixture.mjs";

export function closedTraceFixture(version = 1) {
  const f = barrierTraceFixture(version);
  const protection = f.queries.pop();
  f.trace.spans.splice(f.trace.spans.indexOf(protection), 1);
  f.expected.rejection = "agent_unavailable";
  f.expected.rejectionReceipt.code = "agent_unavailable";
  for (const span of f.trace.spans)
    for (const fields of [span.tags, ...(span.logs ?? []).map((e) => e.fields)])
      for (const field of fields ?? [])
        if (typeof field.value === "string")
          field.value = field.value.replaceAll(
            "runtime_barrier_required",
            "agent_unavailable",
          );
  return f;
}
