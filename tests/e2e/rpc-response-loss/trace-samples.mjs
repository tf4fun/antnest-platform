import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function traceSampleRecorder(directory) {
  return (label, trace, sample, phase = "collect") => {
    assert(/^[a-z0-9-]+$/u.test(label), "invalid trace evidence label");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(directory, `${label}.samples.jsonl`),
      `${JSON.stringify({ phase, ...sample, trace })}\n`,
      { mode: 0o600 },
    );
    if (trace) {
      const suffix = phase === "after_failure" ? "-after-failure" : "";
      writeFileSync(
        join(directory, `${label}${suffix}.json`),
        JSON.stringify(trace),
        {
          mode: 0o600,
        },
      );
    }
    return trace;
  };
}

// This is evidence after a failed scenario, never a second admission attempt.
export async function captureTraceAfterFailure(base, lifecycle, record) {
  for (const expected of lifecycle) {
    const query_started_at = Date.now();
    let trace;
    let error;
    try {
      const response = await fetch(`${base}/api/traces/${expected.traceID}`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      trace = (await response.json()).data?.[0];
      assert.equal(trace?.traceID, expected.traceID);
    } catch {
      trace = undefined;
      error = "query_failed";
    }
    record(
      expected.kind,
      trace,
      {
        attempt: 1,
        query_started_at,
        sample_received_at: Date.now(),
        ...(error ? { error } : {}),
      },
      "after_failure",
    );
  }
}
