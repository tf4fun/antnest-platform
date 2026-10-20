import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { assertHealthProjection } from "./health-evidence.mjs";
import { foundationTraceExitCode } from "./foundation-evidence.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
let validateState;

export function healthPublicResult(result) {
  const { private_health_state, private_state_closed, ...publicResult } =
    result;
  return publicResult;
}

export function healthPrivateAdmission(result) {
  validateState ??= new (require("ajv/dist/2020.js").Ajv2020)({
    strict: false,
  }).compile(schema);
  assert.equal(result.profile, "runtime-health");
  assert.equal(result.operations, 3);
  assert.equal(result.execution_audits, 0);
  assert.equal(result.model_requests, 0);
  for (const flag of [
    "private_state_closed",
    "unhealthy_closes_acp_access",
    "same_process_recovery_preserves_binding",
    "healthy_restart_requires_rebuild",
    "explicit_rebuild_recovers",
    "workspace_preserved",
    "deleted_before_teardown",
  ])
    assert.equal(result[flag], true, flag);
  const unique = (values) => {
    assert(
      values.every((value) => typeof value === "string" && value.length > 0),
    );
    assert.equal(new Set(values).size, values.length);
  };
  const traces = result.traces;
  assert.deepEqual(
    traces.map((trace) => trace.kind),
    ["create", "rebuild", "delete"],
  );
  unique(traces.map((trace) => trace.trace_id));
  unique(traces.map((trace) => trace.request_id));
  traces.forEach((trace) => assert.equal(trace.agent_id, result.agent_id));
  const { initial, reads, observations } = result.private_health_state;
  assert.equal(initial.agent_id, result.agent_id);
  assert(reads.length >= 5);
  for (const receipt of reads) {
    assert(["unhealthy", "recovered", "restarted"].includes(receipt.phase));
    assert.deepEqual(
      [receipt.agentId, receipt.method, receipt.path, receipt.status],
      [
        result.agent_id,
        "POST",
        "/rpc/agent-acp/get-agent-execution-state",
        200,
      ],
    );
    const state = JSON.parse(receipt.rawBody);
    assert(validateState(state), "invalid complete Health state evidence");
    assert.equal(state.agent_id, result.agent_id);
    assert.equal(state.access_allowed, true);
    assert.match(state.configuration_revision, /^[a-f0-9]{64}$/u);
    assert.equal(state.active_session_id, null);
  }
  assert.deepEqual(
    observations.map((item) => item.phase),
    ["unhealthy", "recovered", "restarted", "restarted", "restarted"],
  );
  let previous = -1;
  for (const observation of observations) {
    const index = observation.receipt_index;
    assert(
      Number.isSafeInteger(index) && index > previous && index < reads.length,
    );
    previous = index;
    assert.equal(reads[index].phase, observation.phase);
    assertHealthProjection(
      initial,
      observation.agent,
      JSON.parse(reads[index].rawBody),
      observation.phase,
    );
  }
  const strict = foundationTraceExitCode(traces);
  // Health has no ACP requests or worker restarts. Only the already reviewed
  // lifecycle/clock policy applies; busy and restart allowances are unrelated.
  const accepted =
    traces.every(
      (trace) =>
        trace.topology === "passed" &&
        ["passed", "failed"].includes(trace.strict_trace) &&
        (trace.strict_trace !== "passed" ||
          ((trace.error_spans ?? 0) === 0 &&
            (trace.warning_count ?? 0) === 0 &&
            (trace.warnings ?? []).length === 0)) &&
        trace.rejection === undefined &&
        (trace.restart_error_spans ?? 0) === 0 &&
        (trace.resolve_source_error_spans ?? 0) === 0 &&
        (trace.expected_transport_faults ?? 0) === 0,
    ) && clockWarningsOnly(traces)
      ? 0
      : 1;
  return {
    strict_exit: strict,
    accepted_exit: accepted,
    inventory: {
      lifecycle_admissions: 3,
      state_reads: reads.length,
      confirmed_observations: 5,
      acp_connections: 0,
      runs: 0,
      model_requests: 0,
    },
  };
}
