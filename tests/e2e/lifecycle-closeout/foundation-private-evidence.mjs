import assert from "node:assert/strict";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
import { foundationPrivateOutcome } from "./foundation-private-trace.mjs";
import {
  foundationTraceExitCode,
  foundationAcceptedTraceExitCode,
} from "./foundation-evidence.mjs";

const unique = (values) =>
  assert.equal(
    new Set(values).size,
    values.length,
    "duplicate Foundation identity",
  );
const busyReceipt = { rpcCode: -32020, code: "agent_busy", retryable: false };

export function foundationPublicResult(result) {
  const { private_connections, private_state_receipts, ...work } =
    result.active_run_rebuild;
  return { ...result, active_run_rebuild: work };
}

// This default-only gate binds the original wire/Run/Provider inventory before
// applying the owning trace policies. A diagnostic exit code alone is not proof
// that the held Run, both busy requests or independent lifecycle work happened.
export function foundationPrivateAdmission(result) {
  assert.equal(result.profile, "lifecycle-foundation-and-startup-failure");
  const work = result.active_run_rebuild;
  assert.equal(work.cleanup_completed, true);
  assert.equal(work.completed_prompts, 2);
  assert.equal(work.denied_prompts, 2);
  const connections = work.private_connections;
  assert.equal(connections.length, 2);
  connections.forEach(checkPrivateACPConnection);
  unique(connections.map((c) => c.connectionTraceID));
  unique(connections.map((c) => c.clientSpanID));
  assert.equal(connections[0].agentId, connections[1].agentId);
  assert(connections.every((c) => c.version === 1));
  const [first, second] = connections.map((c) => c.evidence);
  assert.deepEqual(
    first.map((r) => r.method),
    [
      "session/new",
      "session/new",
      "session/prompt",
      "session/prompt",
      "session/prompt",
    ],
  );
  assert.deepEqual(
    second.map((r) => r.method),
    ["session/load", "session/prompt"],
  );
  const session = first[0].sessionId,
    other = first[1].sessionId;
  assert(
    typeof session === "string" &&
      session.length > 0 &&
      typeof other === "string" &&
      other.length > 0 &&
      session !== other,
  );
  assert.deepEqual(
    first.map((r) => r.sessionId),
    [session, other, session, other, other],
  );
  assert.deepEqual(
    second.map((r) => r.sessionId),
    [session, session],
  );
  const rows = connections.flatMap((c) => [c.initialization, ...c.evidence]);
  for (const row of [...first, ...second]) {
    assert.equal(row.inputSessionID, row.requestParams.sessionId ?? null);
    if (row.rejection) {
      assert.equal(row.outcome, "failed");
      assert.equal(row.rejection, "agent_busy");
      assert.deepEqual(row.rejectionReceipt, busyReceipt);
      const frame = connections[0].raw_frames.find(
        (f) => String(f.id) === row.requestId && f.error,
      );
      assert.equal(frame?.error.code, busyReceipt.rpcCode);
      assert.deepEqual(frame.error.data, {
        code: "agent_busy",
        retryable: false,
      });
    } else {
      assert.equal(row.outcome, "succeeded");
      assert.deepEqual(row.requestReceipt, {
        requestId: row.requestId,
        params: row.requestParams,
        result: row.requestResult,
      });
      if (row.method === "session/prompt")
        assert.equal(row.requestResult.stopReason, "end_turn");
    }
  }
  assert.deepEqual(
    first.map((r) => r.rejection ?? null),
    [null, null, null, "agent_busy", "agent_busy"],
  );
  assert.deepEqual(
    second.map((r) => r.rejection ?? null),
    [null, null],
  );
  assert.deepEqual(
    [first[2], second[1]].map((r) => [r.kind, r.phase, r.toolName ?? "bash"]),
    [
      ["ordinary", "c3-held-run", "bash"],
      ["ordinary", "c3-after-rebuild", "read"],
    ],
  );
  const traces = work.run_traces;
  assert.equal(traces.length, rows.length);
  assert.equal(rows.length, 9);
  unique(traces.map((t) => t.trace_id));
  for (const [i, row] of rows.entries()) {
    const trace = traces[i];
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
    assert.equal(trace.runs, row.kind === "ordinary" ? 1 : 0);
    assert.equal(trace.runtime_tool_calls, row.kind === "ordinary" ? 1 : 0);
    assert.equal(trace.rejection, row.rejection);
    if (row.rejection) assert.equal(trace.no_execution, true);
  }
  const runs = traces.filter((t) => t.runs === 1);
  assert.equal(runs.length, 2);
  assert.equal(work.run_ids.length, 2);
  unique(work.run_ids);
  assert.deepEqual(
    runs.map((t) => t.run_id),
    work.run_ids,
  );
  assert.deepEqual(
    work.provider_requests.map((r) => [r.phase, r.stage, r.trace_id]),
    [
      ["c3-held-run", "tool", runs[0].trace_id],
      ["c3-held-run", "reply", runs[0].trace_id],
      ["c3-after-rebuild", "tool", runs[1].trace_id],
      ["c3-after-rebuild", "reply", runs[1].trace_id],
    ],
  );
  assert(work.private_state_receipts.length > 0);
  const states = work.private_state_receipts.map((receipt) => {
    assert.deepEqual(
      [receipt.agentId, receipt.method, receipt.path, receipt.status],
      [
        connections[0].agentId,
        "POST",
        "/rpc/agent-acp/get-agent-execution-state",
        200,
      ],
    );
    const state = JSON.parse(receipt.rawBody);
    assert.equal(state.agent_id, connections[0].agentId);
    assert.equal(state.access_allowed, true);
    assert.match(state.configuration_revision, /^[a-f0-9]{64}$/u);
    assert.equal(state.availability, "busy");
    assert.equal(state.active_session_id, session);
    assert([null, "agent_unavailable"].includes(state.unavailable_reason));
    return state;
  });
  assert(states.some((s) => s.unavailable_reason === "agent_unavailable"));
  const lifecycle = result.traces.filter((t) =>
    ["create", "rebuild", "disable", "enable", "delete"].includes(t.kind),
  );
  const replay = result.traces.filter((t) => t.kind === "create-replay");
  const observations = result.traces.filter(
    (t) => t.kind === "runtime-observation",
  );
  assert.equal(result.operations, 9);
  assert.deepEqual(lifecycle.map((t) => t.kind).sort(), [
    "create",
    "create",
    "create",
    "delete",
    "delete",
    "delete",
    "disable",
    "enable",
    "rebuild",
  ]);
  assert.deepEqual(
    result.lifecycle_kinds,
    lifecycle.map((t) => t.kind),
  );
  assert.equal(replay.length, 1);
  assert.equal(replay[0].readonly_transaction, true);
  assert(
    typeof replay[0].agent_id === "string" && replay[0].agent_id.length > 0,
  );
  assert(observations.length >= 1);
  for (const observation of observations) {
    assert.equal(observation.agent_id, replay[0].agent_id);
    assert(
      typeof observation.event_id === "string" &&
        observation.event_id.length > 0,
    );
  }
  unique(observations.map((t) => t.event_id));
  assert.equal(result.replay_observation_events, observations.length);
  assert.equal(result.traces.length, 10 + observations.length);
  // One synchronize operation may commit multiple distinct condition events.
  // Each keeps its own persisted provenance proof; their shared root must still
  // be independent of every command, read-only replay and private ACP request.
  const observationTraces = [...new Set(observations.map((t) => t.trace_id))];
  unique(
    [...lifecycle, ...replay, ...traces]
      .map((t) => t.trace_id)
      .concat(observationTraces),
  );
  const diagnostics = foundationPrivateOutcome(traces);
  const lifecycleStrict = foundationTraceExitCode(result.traces);
  const lifecycleAccepted = foundationAcceptedTraceExitCode(
    result.traces,
    "foundation",
  );
  return {
    strict_exit:
      lifecycleStrict === 1 || diagnostics.exit_code === 1
        ? 1
        : Math.max(lifecycleStrict, diagnostics.exit_code),
    accepted_exit: diagnostics.accepted && lifecycleAccepted === 0 ? 0 : 1,
    private_diagnostics: diagnostics,
    inventory: {
      connections: 2,
      initializations: 2,
      business_requests: 7,
      runs: 2,
      provider_requests: 4,
      runtime_tool_calls: 2,
      lifecycle_admissions: 9,
      create_replays: 1,
      observation_events: observations.length,
      observation_traces: observationTraces.length,
    },
  };
}
