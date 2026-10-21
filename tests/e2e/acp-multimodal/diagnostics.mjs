import assert from "node:assert/strict";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import {
  collectPrivateNativeTrace,
  privateNativeStrictOutcome,
} from "./collector.mjs";

// Run only after the independent business, Runtime ACK and deletion checks.
// Failed diagnostics retain their position without inventing a Trace or Run.
export async function collectNativeTraceDiagnostics(
  base,
  inventory,
  options = {},
) {
  const {
    collectRequest = collectPrivateNativeTrace,
    diagnostics = createTraceDiagnostics(options),
  } = options;
  const checked = [];
  const requests = [...inventory.requests, ...inventory.initializations];
  for (const [index, expected] of requests.entries()) {
    const diagnostic = await diagnostics.run(
      `native-request-${index}`,
      (signal) => collectRequest(base, expected, { ...options, signal }),
    );
    checked.push(
      diagnostic.status === "passed"
        ? diagnostic.value
        : { label: expected.label, diagnostic },
    );
  }
  await diagnostics.run("native-trace-inventory", async () => {
    assert.equal(checked.length, 60);
    assert(checked.every((row) => row.trace_id));
    assert.equal(new Set(checked.map((row) => row.trace_id)).size, 60);
    const runs = checked.filter((row) => row.run_id);
    assert.equal(runs.length, 12);
    assert.equal(new Set(runs.map((row) => row.run_id)).size, 12);
    const native = checked.filter((row) => row.kind === "native");
    assert.equal(native.length, 9);
    assert.deepEqual(
      new Set(native.map((row) => row.trace_id)),
      new Set((options.requests ?? []).map((row) => row.trace_id)),
    );
  });
  const strict = privateNativeStrictOutcome(checked);
  await diagnostics.run("native-strict-trace-result", async () => {
    assert.equal(
      strict.exit_code,
      0,
      "original strict Trace findings retained as auxiliary diagnostics",
    );
  });
  return { checked, strict, trace_diagnostics: diagnostics.summary() };
}
