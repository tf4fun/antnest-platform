import assert from "node:assert/strict";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import {
  collectPrivateProgressTrace,
  collectPrivateProgressNotificationTrace,
  privateProgressStrictOutcome,
} from "./collector.mjs";

// Call after the independent scenario, model, Runtime ACK and deletion checks.
// Missing diagnostics retain their position without inventing a Trace or Run.
export async function collectProgressTraceDiagnostics(
  base,
  inventory,
  options = {},
) {
  const {
    collectRequest = collectPrivateProgressTrace,
    collectNotification = collectPrivateProgressNotificationTrace,
    diagnostics = createTraceDiagnostics(options),
  } = options;
  const checked = [];
  const requests = [...inventory.requests, ...inventory.initializations];
  for (const [index, expected] of requests.entries()) {
    const diagnostic = await diagnostics.run(
      `progress-request-${index}`,
      (signal) => collectRequest(base, expected, { ...options, signal }),
    );
    checked.push(
      diagnostic.status === "passed"
        ? diagnostic.value
        : { label: expected.label, diagnostic },
    );
  }
  for (const [index, { phase, receipt }] of inventory.notifications.entries()) {
    const diagnostic = await diagnostics.run(
      `progress-notification-${index}`,
      (signal) => collectNotification(base, receipt, { ...options, signal }),
    );
    checked.push(
      diagnostic.status === "passed"
        ? diagnostic.value
        : { label: phase, diagnostic },
    );
  }
  await diagnostics.run("progress-trace-inventory", async () => {
    assert.equal(checked.length, 76);
    assert(checked.every((row) => row.trace_id));
    assert.equal(new Set(checked.map((row) => row.trace_id)).size, 76);
    const runs = checked.filter((row) => row.run_id);
    assert.equal(runs.length, 12);
    assert.equal(new Set(runs.map((row) => row.run_id)).size, 12);
    assert.deepEqual(
      new Set(runs.map((row) => row.trace_id)),
      new Set((options.requests ?? []).map((row) => row.trace_id)),
    );
  });
  const strict = privateProgressStrictOutcome(checked);
  await diagnostics.run("progress-strict-trace-result", async () => {
    assert.equal(
      strict.exit_code,
      0,
      "original strict Trace findings retained as auxiliary diagnostics",
    );
  });
  return { checked, strict, trace_diagnostics: diagnostics.summary() };
}
