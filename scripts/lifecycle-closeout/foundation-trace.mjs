import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { inspectCrashTrace } from "./crash-trace.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";

export function saveFoundationTrace(config, trace) {
  if (!trace) return;
  assert.match(trace.traceID, /^[a-f0-9]{32}$/);
  writeFileSync(
    `${config.evidence}/traces/${trace.traceID}.json`,
    JSON.stringify(trace),
    { mode: 0o600 },
  );
}
export function saveFoundationFailure(config, operation, error) {
  assert.match(operation.traceID, /^[a-f0-9]{32}$/);
  writeFileSync(
    `${config.evidence}/traces/${operation.traceID}.failure.private.txt`,
    String(error.stack),
    { mode: 0o600 },
  );
}
export async function collectFoundationLifecycle(
  config,
  operation,
  secrets,
  signal,
) {
  return collectTrace(
    config.jaeger,
    operation.traceID,
    (trace) => {
      saveFoundationTrace(config, trace);
      return (operation.crashRecovery ? inspectCrashTrace : inspectLifecycle)(
        trace,
        {
          kind: operation.kind,
          crashRecovery: operation.crashRecovery,
          requestId: operation.requestID,
          agentId: operation.agentID,
          traceID: operation.traceID,
          workerRestart: operation.workerRestart,
          updateRestart: operation.updateRestart,
          settlementOutcome: operation.settlementOutcome,
          networkAlreadyClosed: operation.networkAlreadyClosed,
          missingSourceGeneration: operation.missingSourceGeneration,
        },
        secrets,
      );
    },
    signal,
  );
}
