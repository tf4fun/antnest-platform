import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import { barrierTraceFixture } from "../acp-progress/control-trace.fixture.mjs";

export function closedTraceFixture(version = 1) {
  const f = barrierTraceFixture(version);
  const protection = f.queries.pop();
  f.trace.spans.splice(f.trace.spans.indexOf(protection), 1);
  const receipt = admissionErrorReceipt("agent_unavailable");
  f.expected.rejection = "agent_unavailable";
  f.expected.rejectionReceipt = {
    rpcCode: receipt.code,
    code: "agent_unavailable",
    retryable: receipt.data.retryable,
  };
  for (const span of f.trace.spans)
    for (const fields of [span.tags, ...(span.logs ?? []).map((e) => e.fields)])
      for (const field of fields ?? []) {
        if (typeof field.value === "string")
          field.value = field.value
            .replaceAll("runtime_barrier_required", "agent_unavailable")
            .replaceAll("-32036", String(receipt.code));
        else if (field.value === -32036) field.value = receipt.code;
      }
  return f;
}
