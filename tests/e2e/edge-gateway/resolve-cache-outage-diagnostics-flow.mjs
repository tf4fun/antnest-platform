import assert from "node:assert/strict";
import { assertOutageAdmission } from "../../support/resolve-cache-admission.mjs";

// Only collection and Trace inspection enter this boundary. The caller owns
// actual HTTP, Run settlement, observer joins and container cleanup.
export async function collectOutageDiagnostics(
  { evidence, diagnostics, signal },
  { archive, admit = assertOutageAdmission },
) {
  signal?.throwIfAborted();
  const diagnostic = await diagnostics.run("outage-collection", (localSignal) =>
    archive(localSignal, evidence),
  );
  const raw = diagnostic.status === "passed" ? diagnostic.value : undefined;
  await diagnostics.run("outage-trace-admission", async () => {
    assert.equal(
      diagnostic.status,
      "passed",
      "outage Trace collection unavailable",
    );
    admit(raw);
    assert.equal(
      raw.strict_trace,
      "passed",
      "original strict Trace findings retained",
    );
  });
  return {
    diagnostic,
    trace_evidence: raw,
    trace_diagnostics: diagnostics.summary(),
  };
}
