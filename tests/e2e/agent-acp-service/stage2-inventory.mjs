import assert from "node:assert/strict";

export const stage2Scenarios = [
  "create",
  "same-run-credential-rotation",
  "controller-offline-execution",
  "rebuild-active-execution",
  "disable-enable",
  "acp-crash-records-interruption-without-replay",
  "identity-revocation",
  "delete-and-retain-execution-audit",
  "authenticated-audit-consumer",
];
function traceID(value) {
  assert.match(value, /^[a-f0-9]{32}$/u);
  assert.notEqual(value, "0".repeat(32));
  return value;
}
function unique(rows, field, count) {
  assert.equal(rows.length, count, `Stage2 ${field} inventory changed`);
  for (const row of rows) assert(typeof row[field] === "string" && row[field]);
  assert.equal(
    new Set(rows.map((row) => row[field])).size,
    count,
    `duplicate Stage2 ${field}`,
  );
}

export function stage2CompletedTraceIDs(modelCalls, interrupted) {
  const { requests, attempts } = modelCalls;
  assert.equal(
    requests.length,
    13,
    "Stage2 requires thirteen original model requests",
  );
  assert.equal(
    attempts.length,
    13,
    "Stage2 model attempts contain replay or missing completion",
  );
  traceID(interrupted.trace_id);
  traceID(interrupted.scenario_trace_id);
  assert.notEqual(interrupted.trace_id, interrupted.scenario_trace_id);
  assert.equal(interrupted.state, "failed");
  assert.equal(interrupted.error_class, "service_restarted_during_run");
  assert.equal(interrupted.trace_complete, false);
  const groups = new Map();
  for (const [index, request] of requests.entries()) {
    const id = traceID(request.trace_id);
    assert.equal(request.request_number, index + 1);
    assert.equal(
      attempts[index].trace_id,
      id,
      "model attempt/request identity changed",
    );
    assert.equal(
      attempts[index].status,
      id === interrupted.trace_id ? 499 : 200,
    );
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(request.has_tool_result);
  }
  assert.equal(groups.size, 7, "Stage2 requires seven independent Run traces");
  assert.deepEqual(groups.get(interrupted.trace_id), [false]);
  groups.delete(interrupted.trace_id);
  for (const [id, values] of groups) {
    assert.notEqual(
      id,
      interrupted.scenario_trace_id,
      "recovery Run must own its independent trace",
    );
    assert.deepEqual(
      values,
      [false, true],
      "each completed Run needs its original Tool result continuation",
    );
  }
  return [...groups.keys()];
}

export function assertStage2Inventory(value) {
  const { agentId, audits, execution, interrupted, management, workflows } =
    value;
  assert(typeof agentId === "string" && agentId);
  assert.deepEqual(value.scenarios, stage2Scenarios);
  const completed = stage2CompletedTraceIDs(value.modelCalls, interrupted);
  unique(audits, "run_id", 7);
  unique(execution, "run_id", 6);
  unique(execution, "trace_id", 6);
  assert.deepEqual(
    new Set(execution.map((run) => run.trace_id)),
    new Set(completed),
  );
  for (const audit of audits) {
    assert.equal(audit.agent_id, agentId);
    assert(typeof audit.session_id === "string" && audit.session_id);
    assert.equal(
      audit.state,
      audit.run_id === interrupted.run_id ? "failed" : "completed",
    );
  }
  const killed = audits.filter((audit) => audit.run_id === interrupted.run_id);
  assert.equal(killed.length, 1, "original interrupted Run audit missing");
  for (const run of execution) {
    assert.equal(run.agent_id, agentId);
    const audit = audits.find((row) => row.run_id === run.run_id);
    assert(
      audit && audit.state === "completed",
      "completed Run has no matching terminal audit",
    );
    assert.equal(run.session_id, audit.session_id);
    assert.equal(
      run.runtime_tool_calls,
      1,
      "each completed Run must retain its Runtime write",
    );
  }
  unique(management, "trace_id", 2);
  for (const row of management) traceID(row.trace_id);
  assert.deepEqual(
    management.map((row) => row.kind),
    ["create", "rebuild"],
  );
  assert.equal(workflows.length, 5);
  assert.equal(new Set(workflows).size, 5);
  for (const [index, kind] of [
    "create",
    "rebuild",
    "disable",
    "enable",
    "delete",
  ].entries())
    assert(
      workflows[index].startsWith(`agent-${kind}/`) &&
        workflows[index].length > kind.length + 7,
    );
  assert.equal(
    value.auditTraceCount,
    48,
    "all authenticated audit reads require their original trace",
  );
  return {
    scenarios: 9,
    runs: 7,
    completed_runs: 6,
    interrupted_runs: 1,
    model_requests: 13,
    runtime_writes: 6,
    audit_traces: 48,
    workflows: 5,
    management_traces: 2,
  };
}
