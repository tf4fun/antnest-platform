import assert from "node:assert/strict";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { workspaceFailures } from "./private-flow.mjs";
import {
  inspectWorkspaceBusiness,
  workspacePrivateAdmission,
} from "./private-evidence.mjs";

// Actual protocol, durable effects, authority and resource joins are admitted
// before inspecting any collected Trace. Docker cleanup is still owned by the
// outer runner and must finish before its public completion report is emitted.
export async function admitWorkspaceBusiness(
  result,
  { directory, signal, diagnostics = result.workspaceDiagnostics } = {},
) {
  signal?.throwIfAborted();
  workspaceFailures(result.workspaceErrors);
  const business = inspectWorkspaceBusiness(result);
  diagnostics ??= createTraceDiagnostics({ directory, signal });
  const checked = await diagnostics.run("workspace-strict-admission", () =>
    workspacePrivateAdmission(result),
  );
  const raw = checked.status === "passed" ? checked.value : null;
  if (raw)
    await diagnostics.run("workspace-strict-exit", () =>
      assert.equal(raw.strict_exit, 0),
    );
  signal?.throwIfAborted();
  const summary = diagnostics.summary();
  const exporter = result.trace_diagnostics?.exporter;
  return {
    ...business,
    accepted_exit: 0,
    strict_exit: raw?.strict_exit ?? 2,
    raw_admission: raw,
    trace_diagnostics: {
      ...summary,
      ...(exporter ? { exporter } : {}),
      status:
        summary.status === "passed" &&
        (!exporter || exporter.status === "passed")
          ? "passed"
          : "warning",
    },
  };
}
