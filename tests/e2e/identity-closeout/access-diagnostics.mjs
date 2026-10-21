import { inspect } from "node:util";
import { writeEvidenceFile } from "../../support/storage.mjs";

// All original business/authority checks and their archives belong outside
// this boundary. The caller shares this budget with inline offboarding checks.
export async function collectAccessDiagnostics(
  { diagnostics, requests },
  {
    collectManagement,
    collectRequest,
    collectClosures,
    inspect: inspectResults,
  },
) {
  const management = await diagnostics.run(
    "access-management",
    collectManagement,
  );
  const reports = [];
  for (const [index, request] of requests.entries()) {
    const diagnostic = await diagnostics.run(
      `access-request-${index}`,
      (signal) => collectRequest(request, signal),
    );
    reports.push(
      diagnostic.status === "passed"
        ? diagnostic.value
        : { label: request?.label, diagnostic },
    );
  }
  const closures = await diagnostics.run(
    "access-browser-closures",
    collectClosures,
  );
  const result = {
    reports,
    management: management.status === "passed" ? management.value : null,
    closures: closures.status === "passed" ? closures.value : null,
  };
  await diagnostics.run("access-strict-inventory", (signal) =>
    inspectResults(result, signal),
  );
  return { ...result, trace_diagnostics: diagnostics.summary() };
}

export async function shutdownAccessTelemetry(
  telemetry,
  { directory, diagnostics },
) {
  try {
    // Budget exhaustion never skips the actual exporter shutdown or its join.
    await telemetry.shutdown();
  } catch (error) {
    console.warn(
      "Access telemetry shutdown failed; auxiliary diagnostics retained",
    );
    try {
      writeEvidenceFile(
        directory,
        "access-telemetry-shutdown.private.txt",
        inspect(error, { depth: 8 }),
      );
      await diagnostics.run("access-telemetry-shutdown", () => {
        throw error;
      });
    } catch {
      console.warn("Access telemetry diagnostic archival failed");
    }
  }
}
