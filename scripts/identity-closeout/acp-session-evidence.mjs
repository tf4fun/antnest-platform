import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { assertSecretFree } from "./evidence.mjs";

export function assertCompletedRun(run, accepted, tools) {
  assert(
    run?.id === accepted.id && run.admission_id === accepted.admission_id,
    "Run/admission was replaced",
  );
  assert(
    run.state === "completed" &&
      run.terminal_class === "completed" &&
      run.stop_reason === "end_turn",
    "Run did not complete normally",
  );
  assert(
    run.error_class === null && run.cancel_requested_at === null,
    "Run was cancelled or failed",
  );
  assert(run.admission_finished_at, "completed Run did not release admission");
  assert(
    tools.length === 1 && tools[0].state === "completed",
    "missing, duplicated or unsettled Tool",
  );
}

export function inspectSessionTrace(trace, traceID, secrets) {
  assert(
    trace?.traceID === traceID && trace.spans?.length,
    "wrong or missing trace",
  );
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  const service = (span) => trace.processes[span.processID]?.serviceName;
  const tag = (span, key) => span.tags?.find((item) => item.key === key)?.value;
  const root = trace.spans.find(
    (span) =>
      service(span) === "edge-gateway" &&
      tag(span, "http.response.status_code") === 101,
  );
  assert(root, "Gateway upgrade completion missing");
  const checks = trace.spans.filter(
    (span) =>
      service(span) === "edge-gateway" &&
      span.operationName === "identity.resolve",
  );
  assert(checks.length >= 4, "message-level Identity checks missing");
  for (const check of checks) {
    let current = check;
    const seen = new Set();
    while (current && current !== root && !seen.has(current.spanID)) {
      seen.add(current.spanID);
      const parent = current.references?.find(
        (ref) => ref.refType === "CHILD_OF" && ref.traceID === traceID,
      );
      current = spans.get(parent?.spanID);
    }
    assert(current === root, "message check lacks Gateway ancestry");
  }
  const failed = checks.filter(
    (span) =>
      tag(span, "error") === true || tag(span, "otel.status_code") === "ERROR",
  );
  assert(failed.length > 0, "denied Identity check missing");
  assertSecretFree(JSON.stringify(trace), secrets);
  return {
    trace_id: traceID,
    spans: trace.spans.length,
    session_checks: checks.length,
    failed_checks: failed.length,
    gateway_ancestry: true,
  };
}

export async function verifySessionTraces(base, traceIDs, secrets) {
  const results = [];
  for (const traceID of traceIDs) {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`${base}/api/traces/${traceID}`, {
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(response.status, 200);
        results.push(
          inspectSessionTrace(
            (await response.json()).data?.[0],
            traceID,
            secrets,
          ),
        );
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
      await delay(500);
    }
    if (lastError) throw lastError;
  }
  return results;
}
