import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./stage2-inventory.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const id = (value) => value.toString(16).padStart(32, "0");
function fixture() {
  const requests = [],
    attempts = [],
    execution = [],
    audits = [];
  for (let run = 1; run <= 7; run++) {
    audits.push({
      run_id: `run-${run}`,
      session_id: `session-${run}`,
      agent_id: "agent",
      state: run === 7 ? "failed" : "completed",
    });
    if (run !== 7)
      execution.push({
        run_id: `run-${run}`,
        session_id: `session-${run}`,
        agent_id: "agent",
        trace_id: id(run),
        runtime_tool_calls: 1,
      });
    for (let index = 0; index < (run === 7 ? 1 : 2); index++) {
      requests.push({
        request_number: requests.length + 1,
        trace_id: id(run),
        has_tool_result: index === 1,
      });
      attempts.push({ trace_id: id(run), status: run === 7 ? 499 : 200 });
    }
  }
  return {
    agentId: "agent",
    audits,
    execution,
    modelCalls: { requests, attempts },
    interrupted: {
      run_id: "run-7",
      trace_id: id(7),
      scenario_trace_id: id(8),
      state: "failed",
      error_class: "service_restarted_during_run",
      trace_complete: false,
    },
    scenarios: [
      "create",
      "same-run-credential-rotation",
      "controller-offline-execution",
      "rebuild-active-execution",
      "disable-enable",
      "acp-crash-records-interruption-without-replay",
      "identity-revocation",
      "delete-and-retain-execution-audit",
      "authenticated-audit-consumer",
    ],
    management: [
      { kind: "create", trace_id: id(9) },
      { kind: "rebuild", trace_id: id(10) },
    ],
    workflows: [
      "agent-create/create",
      "agent-rebuild/rebuild",
      "agent-disable/disable",
      "agent-enable/enable",
      "agent-delete/delete",
    ],
    auditTraceCount: 48,
  };
}
function inspect(value) {
  assert.equal(typeof implementation.assertStage2Inventory, "function");
  return implementation.assertStage2Inventory(value);
}
test("Stage2 requires all nine scenarios, seven audits and six complete independent Run traces", () => {
  const f = fixture();
  assert.deepEqual(inspect(f), {
    scenarios: 9,
    runs: 7,
    completed_runs: 6,
    interrupted_runs: 1,
    model_requests: 13,
    runtime_writes: 6,
    audit_traces: 48,
    workflows: 5,
    management_traces: 2,
  });
});
for (const [name, mutate] of [
  ["omitted recovery Run", (f) => f.execution.pop()],
  [
    "duplicate Run proof",
    (f) => {
      f.execution[5] = structuredClone(f.execution[4]);
    },
  ],
  [
    "recovery sharing the interrupted scenario",
    (f) => {
      f.interrupted.scenario_trace_id = id(6);
    },
  ],
  [
    "extra model replay",
    (f) => {
      f.modelCalls.requests.push(structuredClone(f.modelCalls.requests[0]));
    },
  ],
  [
    "missing model completion",
    (f) => {
      f.modelCalls.requests[1].has_tool_result = false;
    },
  ],
  [
    "failed successful model attempt",
    (f) => {
      f.modelCalls.attempts[0].status = 401;
    },
  ],
  [
    "different interrupted Trace",
    (f) => {
      f.interrupted.trace_id = id(6);
    },
  ],
  [
    "foreign audit Agent",
    (f) => {
      f.audits[0].agent_id = "foreign";
    },
  ],
  [
    "foreign Run Session",
    (f) => {
      f.execution[0].session_id = "foreign";
    },
  ],
  [
    "audit still running",
    (f) => {
      f.audits[0].state = "running";
    },
  ],
  [
    "missing Runtime write",
    (f) => {
      f.execution[0].runtime_tool_calls = 0;
    },
  ],
  ["omitted scenario", (f) => f.scenarios.pop()],
  ["omitted Temporal history", (f) => f.workflows.pop()],
  ["omitted audit trace", (f) => f.auditTraceCount--],
  [
    "duplicate management trace",
    (f) => {
      f.management[1].trace_id = f.management[0].trace_id;
    },
  ],
])
  test(`Stage2 inventory rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.equal(typeof implementation.assertStage2Inventory, "function");
    assert.throws(() => inspect(f));
  });
