import assert from "node:assert/strict";
import { identityEvidenceExitCode } from "../identity-closeout/trace.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";

export function foundationLifecycleExpectation(kind, expectation = {}) {
  return {
    ...expectation,
    ...(["create", "enable", "rebuild"].includes(kind)
      ? { skillPreparation: true }
      : {}),
  };
}

export function foundationAcceptedTraceExitCode(
  evidence,
  profile = "foundation",
) {
  const strictCode = foundationTraceExitCode(evidence);
  if (
    strictCode !== 2 ||
    !["foundation", "restore", "skill-restore"].includes(profile)
  )
    return strictCode;
  const restarts = evidence.filter(
    (item) => (item.restart_error_spans ?? 0) > 0,
  );
  if (restarts.length > 1) return strictCode;
  const reviewed =
    evidence.length > 0 &&
    evidence.every((item) => {
      if (
        item.topology !== "passed" ||
        (item.platform_probe_errors ?? 0) !== 0 ||
        (item.expected_transport_faults ?? 0) !== 0 ||
        !(item.warnings ?? []).every((warning) =>
          /^clock skew adjustment disabled; not applying calculated delta of -?[0-9.]+(?:ns|µs|ms|s)$/.test(
            warning,
          ),
        )
      )
        return false;
      if (item.rejection !== undefined)
        return (
          item.rejection === "agent_busy" &&
          item.no_execution === true &&
          item.runs === 0 &&
          item.error_spans === 2 &&
          (item.restart_error_spans ?? 0) === 0
        );
      if ((item.restart_error_spans ?? 0) > 0)
        return (
          item.kind === "rebuild" &&
          item.restart_error_spans === 3 &&
          Array.isArray(item.workflow_spans) &&
          item.workflow_spans.length === 2 &&
          item.workflow_spans[0].end_reason === "worker_shutdown" &&
          item.workflow_spans[1].end_reason === "workflow_return"
        );
      return (item.error_spans ?? 0) === 0 && clockWarningsOnly([item]);
    });
  return reviewed ? 0 : strictCode;
}

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
