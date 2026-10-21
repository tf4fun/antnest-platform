import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { collectLifecycleAdmissionTrace } from "../stage3-base/resolve-trace.mjs";
import { collectCrashAdmissionTrace } from "./crash-resolution.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import {
  inspectReplayObservation,
  inspectReplayObservationBusiness,
  observationEventQuery,
} from "./replay-history.mjs";
import { lines } from "./docker.mjs";
import { inspectReadonlyCreateReplay } from "./replay-admission.mjs";

export {
  collectCrashAdmissionTrace,
  inspectCrashAdmissionTrace,
} from "./crash-resolution.mjs";

export async function collectReadonlyCreateReplay(
  config,
  expected,
  secrets,
  signal,
  options = {},
) {
  return collectLifecycleAdmissionTrace(config.jaeger, expected, secrets, {
    ...options,
    directory: `${config.evidence}/traces`,
    signal,
    inspect: inspectReadonlyCreateReplay,
  });
}

export async function collectReplayObservation(
  config,
  docker,
  expected,
  secrets,
  signal,
  options = {},
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
  const collect = (localSignal) =>
    (options.collectTrace ?? collectTrace)(
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
      localSignal,
    );
  if (!options.traceDiagnostics) return collect(signal);
  const business = inspectReplayObservationBusiness({ ...expected, persisted });
  const diagnostic = await options.traceDiagnostics.run(
    "foundation-replay-observation",
    (localSignal) => collect(localSignal),
  );
  return { ...business, diagnostic };
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
  options = {},
) {
  const expected = {
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
  };
  // A killed Runtime process has a separately verified recovery projection;
  // its missing-parent contract is not waived by normal admission collection.
  if (operation.crashRecovery)
    return collectCrashAdmissionTrace(config.jaeger, expected, secrets, {
      ...options,
      directory: `${config.evidence}/traces`,
      signal,
    });
  return collectLifecycleAdmissionTrace(config.jaeger, expected, secrets, {
    ...options,
    directory: `${config.evidence}/traces`,
    signal,
    inspect: inspectLifecycle,
  });
}
