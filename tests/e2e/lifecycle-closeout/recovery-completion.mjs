import assert from "node:assert/strict";
import { restorePrivateAdmission } from "./restore-private-evidence.mjs";
import { skillRestorePrivateAdmission } from "./skill-restore-private-evidence.mjs";
import { shutdownPrivateAdmission } from "./shutdown-private-evidence.mjs";

const inspectors = {
  restore: restorePrivateAdmission,
  "skill-restore": skillRestorePrivateAdmission,
  shutdown: shutdownPrivateAdmission,
};

export async function admitRecoveryBusiness(
  profile,
  result,
  { traceDiagnostics },
) {
  const inspect = inspectors[profile];
  assert.equal(typeof inspect, "function");
  // Raw SDK requests, persistence, physical Runtime changes, closure deadlines
  // and cleanup are checked first, independently of collected Trace data.
  const business = inspect(result, { requireTrace: false });
  let strictExit = 2;
  await traceDiagnostics.run(`${profile}-strict-admission`, () => {
    const diagnostic = inspect(result);
    strictExit = diagnostic.strict_exit;
    if (diagnostic.strict_exit !== 0 || diagnostic.accepted_exit !== 0)
      throw new Error("Recovery Trace admission reported diagnostics", {
        cause: diagnostic,
      });
    return diagnostic;
  });
  return {
    accepted_exit: 0,
    strict_exit: strictExit,
    business: business.inventory,
    trace_diagnostics: traceDiagnostics.summary(),
  };
}
