import assert from "node:assert/strict";
import { identityEvidenceExitCode } from "../identity-closeout/trace.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";

export function assertCompletedExecution(run, agent) {
  assert.equal(run.agent_id, agent.agent_id);
  assert.equal(run.state, "completed");
  assert.equal(run.terminal_class, "completed");
  assert.equal(run.executor_state, "quiescent");
  assert.equal(run.tool_effect_state, "settled");
  assert(
    agent.executable_execution_revision,
    "Agent execution revision missing",
  );
  assert.equal(
    run.execution_snapshot?.executionRevision,
    agent.executable_execution_revision,
    "public Run execution revision differs from the actual Agent",
  );
}

export async function collectLifecycleEvidence(
  operations,
  collect,
  onError,
  signal,
) {
  const evidence = [];
  for (const operation of operations) {
    signal?.throwIfAborted();
    try {
      evidence.push({ ...(await collect(operation)), topology: "passed" });
    } catch (error) {
      signal?.throwIfAborted();
      await onError(operation, error);
      evidence.push({
        kind: operation.kind,
        trace_id: operation.traceID,
        request_id: operation.requestID,
        agent_id: operation.agentID,
        topology: "failed",
        strict_trace: "failed",
        evidence_error: "lifecycle_trace_validation_failed",
      });
    }
  }
  return evidence;
}

export function foundationTraceExitCode(evidence) {
  return evidence.some((e) => e.topology === "failed")
    ? 1
    : identityEvidenceExitCode(evidence);
}

export function acceptedClockOnlyRestore(evidence) {
  return (
    evidence.length > 0 &&
    evidence.every((item) => item.topology === "passed") &&
    clockWarningsOnly(evidence)
  );
}
