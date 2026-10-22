import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

// Only observation work belongs here. The caller owns all independent business
// checks, raw business archives, transport closure and resource cleanup.
export async function collectManagedDiagnostics(
  { directory, lifecycle, requests, signal, budgetMs = 60000 },
  { collectLifecycle, collectRequest, inspectInventory } = {},
) {
  const diagnostics = createTraceDiagnostics({ directory, signal, budgetMs });
  const lifecycleReports = [],
    sessionReports = [];
  for (const [index, expected] of lifecycle.entries()) {
    const diagnostic = await diagnostics.run(
      `managed-lifecycle-${index}`,
      (localSignal) => collectLifecycle(expected, localSignal),
    );
    lifecycleReports.push(
      diagnostic.status === "passed"
        ? diagnostic.value
        : { label: expected.label ?? expected.kind, diagnostic },
    );
  }
  for (const [index, expected] of requests.entries()) {
    const diagnostic = await diagnostics.run(
      `managed-request-${index}`,
      (localSignal) => collectRequest(expected, localSignal),
    );
    sessionReports.push(
      diagnostic.status === "passed"
        ? diagnostic.value
        : { label: expected.label, diagnostic },
    );
  }
  const inventory = await diagnostics.run(
    "managed-trace-inventory",
    (localSignal) =>
      inspectInventory({ lifecycleReports, sessionReports }, localSignal),
  );
  return {
    diagnostics: diagnostics.summary(),
    lifecycleReports,
    sessionReports,
    inventory: inventory.status === "passed" ? inventory.value : null,
  };
}
