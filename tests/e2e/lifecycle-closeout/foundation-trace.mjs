import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { inspectCrashTrace } from "./crash-trace.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import {
  inspectReplayObservation,
  observationEventQuery,
} from "./replay-history.mjs";
import { lines } from "./docker.mjs";
import { inspectReadonlyCreateReplay } from "./replay-admission.mjs";

export async function collectReadonlyCreateReplay(
  config,
  expected,
  secrets,
  signal,
) {
  return collectTrace(
    config.jaeger,
    expected.traceID,
    (trace) => {
      saveFoundationTrace(config, trace);
      return inspectReadonlyCreateReplay(trace, expected, secrets);
    },
    signal,
  );
}

export async function collectReplayObservation(
  config,
  docker,
  expected,
  secrets,
  signal,
) {
  const postgres = lines(
    await docker(config.compose(["ps", "-q", "postgres"])),
  );
  assert.equal(postgres.length, 1, "one owned evidence database required");
  const persisted = JSON.parse(
    await docker([
      "exec",
      postgres[0],
      "psql",
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_agent_controller",
      "-d",
      "antnest_agent_controller",
      "-c",
      observationEventQuery(expected.event.event_id),
    ]),
  );
  writeFileSync(
    `${config.evidence}/traces/${expected.event.event_id}.observation.json`,
    JSON.stringify({ event: expected.event, persisted }),
    { mode: 0o600 },
  );
  return collectTrace(
    config.jaeger,
    expected.event.trace_id,
    (trace) => {
      saveFoundationTrace(config, trace);
      return inspectReplayObservation(
        trace,
        { ...expected, persisted },
        secrets,
      );
    },
    signal,
  );
}

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
          skillPreparation: operation.skillPreparation,
          missingSourceGeneration: operation.missingSourceGeneration,
        },
        secrets,
      );
    },
    signal,
  );
}
