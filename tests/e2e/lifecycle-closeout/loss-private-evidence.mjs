import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };
import { assertLossOwner } from "./loss-private-session.mjs";
import { assertReplacement } from "./loss-evidence.mjs";
import { assertRestoreRun } from "./restore-evidence.mjs";
import { foundationTraceExitCode } from "./foundation-evidence.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";
import { lossPrivateOutcome } from "./loss-private-trace.mjs";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
let validateState;
const unique = (values) => {
  assert(values.every((v) => typeof v === "string" && v.length > 0));
  assert.equal(new Set(values).size, values.length, "duplicate Loss identity");
};
export function lossPublicResult(result) {
  const {
    private_loss,
    private_business,
    private_connections,
    private_state_receipts,
    private_collection_errors,
    private_cleanup_completed,
    ...publicResult
  } = result;
  return publicResult;
}

export function lossPrivateAdmission(result) {
  validateState ??= new (require("ajv/dist/2020.js").Ajv2020)({
    strict: false,
  }).compile(schema);
  assert.equal(result.profile, "runtime-loss");
  for (const [field, count] of Object.entries({
    operations: 6,
    completed_runs: 4,
    denied_prompts: 2,
    model_requests: 8,
  }))
    assert.equal(result[field], count, field);
  assert.equal(result.deleted_before_teardown, true);
  assert.equal(result.private_cleanup_completed, true);
  assert.deepEqual(result.private_collection_errors, []);
  const work = result.private_loss,
    connections = result.private_connections,
    requests = result.request_traces;
  assert.equal(work.agents.length, 2);
  assert.equal(connections.length, 6);
  assert.equal(requests.length, 20);
  assert.deepEqual(
    work.agents.map((a) => a.mode),
    ["live", "cold"],
  );
  assert.deepEqual(
    result.cases.map((c) => c.mode),
    ["live", "cold"],
  );
  unique(work.agents.map((a) => a.id));
  unique(work.agents.map((a) => a.session_id));
  unique(work.agents.flatMap((a) => [a.before_run.run_id, a.after_run.run_id]));
  connections.forEach(checkPrivateACPConnection);
  unique(connections.map((c) => c.connectionTraceID));
  unique(connections.map((c) => c.clientSpanID));
  let traceIndex = 0;
  const prompts = [];
  for (const [i, agent] of work.agents.entries()) {
    assertLossOwner(work.principal, work.creation_principal, agent);
    assertReplacement(agent.initial, agent.replacement);
    assert.equal(agent.stopped_runtime.Id, agent.initial.container.Id);
    assert.deepEqual(
      agent.stopped_runtime.Config.Labels,
      agent.initial.container.Config.Labels,
    );
    assert.equal(agent.stopped_runtime.State.Running, false);
    assert.equal(agent.stopped_runtime.State.ExitCode, 0);
    assert.equal(agent.stopped_runtime.State.OOMKilled, false);
    assertRestoreRun([agent.before_run], agent.initial.agent, agent.session_id);
    assertRestoreRun(
      [agent.after_run],
      agent.replacement.agent,
      agent.session_id,
    );
    const summary = result.cases[i];
    assert.equal(summary.agent_id, agent.id);
    assert.equal(
      summary.loss_reason,
      i === 0 ? "runtime_exited" : "runtime_missing",
    );
    assert.equal(
      summary.producer_kind,
      i === 0 ? "runtime_deleted" : "runtime_missing",
    );
    assert(
      Number.isSafeInteger(summary.producer_sequence) &&
        summary.producer_sequence > 0,
    );
    for (const [field, value] of Object.entries({
      completed_prompts: 2,
      denied_prompts: 1,
      history_replay_model_calls: 0,
      normal_runtime_exit: 0,
      same_session: true,
      exact_workspace_bytes: true,
      controller_restart_stable: true,
      current_inspect_loss_audit: true,
      execution_audits_preserved: true,
    }))
      assert.equal(summary[field], value, field);
    for (const [j, connection] of connections
      .slice(i * 3, i * 3 + 3)
      .entries()) {
      assert.equal(connection.version, 1);
      assert.equal(connection.agentId, agent.id);
      assert.deepEqual(
        connection.evidence.map((r) => r.method),
        j === 0
          ? ["session/new", "session/prompt", "session/load"]
          : ["session/load", "session/prompt"],
      );
      for (const row of [connection.initialization, ...connection.evidence]) {
        const trace = requests[traceIndex++];
        assert.equal(trace.topology, "passed");
        assert.deepEqual(
          [
            trace.method,
            trace.request_id,
            trace.connection_trace_id,
            trace.session_id,
          ],
          [row.method, row.requestId, row.connectionTraceID, row.sessionId],
        );
        const prompt = row.method === "session/prompt",
          denied = prompt && j === 1,
          ordinary = prompt && !denied;
        assert.equal(trace.runs, ordinary ? 1 : 0);
        assert.equal(trace.runtime_tool_calls, ordinary ? 1 : 0);
        assert.equal(row.kind, ordinary ? "ordinary" : "request");
        if (row.method === "initialize") {
          assert.equal(row.rejection, undefined);
          assert.equal(row.rejectionReceipt, undefined);
          assert.equal(trace.rejection, undefined);
          continue;
        }
        assert.equal(row.sessionId, agent.session_id);
        const wire = connection.raw_frames.filter(
          (f) =>
            String(f.id) === row.requestId &&
            (Object.hasOwn(f, "result") || Object.hasOwn(f, "error")),
        );
        assert.equal(
          wire.length,
          1,
          "Loss needs the actual response, including a semantic denial",
        );
        if (row.method === "session/new" || row.method === "session/load") {
          assert.equal(
            row.inputSessionID,
            row.method === "session/new" ? null : agent.session_id,
          );
          assert.deepEqual(row.requestParams, {
            ...(row.method === "session/load"
              ? { sessionId: agent.session_id }
              : {}),
            cwd: "/workspace",
            mcpServers: [],
          });
        } else {
          assert.equal(row.inputSessionID, agent.session_id);
          const phase =
            "c5-" +
            agent.mode +
            "-" +
            (denied ? "denied" : j === 0 ? "before" : "after");
          assert.deepEqual(row.requestParams, {
            sessionId: agent.session_id,
            prompt: [{ type: "text", text: phase }],
          });
          if (ordinary) {
            assert.equal(row.phase, phase);
            assert.equal(row.toolName, j === 0 ? "bash" : "read");
            assert.equal(row.requestResult.stopReason, "end_turn");
            assert.equal(
              trace.run_id,
              (j === 0 ? agent.before_run : agent.after_run).run_id,
            );
            prompts.push({ phase, trace_id: trace.trace_id });
          }
        }
        if (denied) {
          assert.equal(row.outcome, "failed");
          assert.equal(row.rejection, "agent_unavailable");
          const expected = admissionErrorReceipt("agent_unavailable");
          assert.deepEqual(row.rejectionReceipt, {
            rpcCode: expected.code,
            code: "agent_unavailable",
            retryable: expected.data.retryable,
          });
          assertAdmissionError(wire[0].error, "agent_unavailable");
          assert.equal(wire[0].error.code, row.rejectionReceipt.rpcCode);
          assert.equal(wire[0].error.data.code, row.rejectionReceipt.code);
          assert.equal(wire[0].error.data.retryable, expected.data.retryable);
          assert.equal(trace.rejection, "agent_unavailable");
          assert.equal(trace.no_execution, true);
        } else {
          assert.equal(row.outcome, "succeeded");
          assert.equal(row.rejection, undefined);
          assert.equal(trace.rejection, undefined);
          assert.deepEqual(row.requestReceipt, {
            requestId: row.requestId,
            params: row.requestParams,
            result: row.requestResult,
          });
          assert.deepEqual(wire[0].result, row.requestResult);
        }
      }
    }
  }
  assert.equal(traceIndex, 20);
  assert.equal(work.provider_requests.length, 8);
  assert.deepEqual(
    work.provider_requests.map(({ phase, stage, trace_id }) => ({
      phase,
      stage,
      trace_id,
    })),
    prompts.flatMap(({ phase, trace_id }) =>
      ["tool", "reply"].map((stage) => ({ phase, stage, trace_id })),
    ),
  );
  const reads = result.private_state_receipts;
  assert(reads.length >= 2);
  for (const read of reads) {
    assert.deepEqual(
      [read.method, read.path, read.status],
      ["POST", "/rpc/agent-acp/get-agent-execution-state", 200],
    );
    const state = JSON.parse(read.rawBody);
    assert(validateState(state), "complete private Loss state required");
    assert.equal(state.agent_id, read.agentId);
    assert(work.agents.some((a) => a.id === read.agentId));
    assert.equal(state.access_allowed, true);
  }
  assert.equal(work.confirmations.length, 2);
  let previous = -1;
  for (const [i, observation] of work.confirmations.entries()) {
    const agent = work.agents[i],
      index = observation.receipt_index;
    assert(
      Number.isSafeInteger(index) && index > previous && index < reads.length,
    );
    previous = index;
    assert.deepEqual(
      [
        observation.mode,
        observation.agent_id,
        observation.connection_trace_id,
        observation.connection_closed,
      ],
      [agent.mode, agent.id, connections[i * 3 + 1].connectionTraceID, false],
    );
    assert.equal(reads[index].agentId, agent.id);
    const state = JSON.parse(reads[index].rawBody);
    assert.equal(state.availability, "offline");
    assert.equal(state.unavailable_reason, "agent_unavailable");
    assert.equal(state.active_session_id, null);
  }
  const admissions = work.lifecycle_admissions;
  assert.equal(admissions.length, 6);
  assert.equal(result.traces.length, 6);
  assert.deepEqual(
    admissions.map((a) => [a.agentID, a.kind]),
    work.agents.flatMap((a) =>
      ["create", "rebuild", "delete"].map((kind) => [a.id, kind]),
    ),
  );
  unique(admissions.map((a) => a.requestID));
  for (const [i, receipt] of admissions.entries()) {
    const trace = result.traces[i];
    assert.deepEqual(
      [trace.trace_id, trace.agent_id, trace.request_id, trace.kind],
      [receipt.traceID, receipt.agentID, receipt.requestID, receipt.kind],
    );
    assert.equal(trace.topology, "passed");
    if (receipt.kind === "rebuild") {
      const generation = Number(
        work.agents[Math.floor(i / 3)].initial.container.Config.Labels[
          "io.antnest.runtime-generation"
        ],
      );
      assert(Number.isSafeInteger(generation) && generation > 0);
      assert.equal(receipt.missingSourceGeneration, generation);
      assert(
        Number.isSafeInteger(trace.platform_absence_probes) &&
          trace.platform_absence_probes > 0,
      );
    } else assert.equal(receipt.missingSourceGeneration, undefined);
  }
  unique([...requests, ...result.traces].map((r) => r.trace_id));
  const privateDiagnostics = lossPrivateOutcome(requests),
    strict = foundationTraceExitCode(result.traces);
  const lifecycle =
    result.traces.every(
      (trace) =>
        ["passed", "failed"].includes(trace.strict_trace) &&
        (trace.strict_trace !== "passed" ||
          ((trace.error_spans ?? 0) === 0 &&
            (trace.warning_count ?? 0) === 0 &&
            (trace.warnings ?? []).length === 0)) &&
        trace.rejection === undefined &&
        (trace.restart_error_spans ?? 0) === 0 &&
        (trace.expected_transport_faults ?? 0) === 0,
    ) && clockWarningsOnly(result.traces);
  return {
    strict_exit:
      strict === 1 || privateDiagnostics.exit_code === 1
        ? 1
        : Math.max(strict, privateDiagnostics.exit_code),
    accepted_exit: lifecycle && privateDiagnostics.accepted ? 0 : 1,
    private_diagnostics: privateDiagnostics,
    inventory: {
      connections: 6,
      initializations: 6,
      business_requests: 14,
      runs: 4,
      provider_requests: 8,
      runtime_tool_calls: 4,
      lifecycle_admissions: 6,
      confirmed_offline_observations: 2,
    },
  };
}
