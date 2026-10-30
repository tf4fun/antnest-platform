import assert from "node:assert/strict";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
import { assertRestoreOwner } from "./restore-private-session.mjs";
import { assertRestoreTransportContinuity } from "./restore-private-transport.mjs";
import { assertRestoreRun, databases } from "./restore-evidence.mjs";
import { foundationTraceExitCode } from "./foundation-evidence.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";
import { restorePrivateOutcome } from "./restore-private-trace.mjs";

function unique(values) {
  assert(values.every((v) => typeof v === "string" && v.length > 0));
  assert.equal(
    new Set(values).size,
    values.length,
    "duplicate Restore identity",
  );
}
export function restorePublicResult(result) {
  const {
    private_restore,
    private_connections,
    private_collection_errors,
    private_cleanup_completed,
    ...publicResult
  } = result;
  return publicResult;
}

export function restorePrivateAdmission(result, { requireTrace = true } = {}) {
  assert.equal(result.profile, "offline-restore");
  for (const [field, count] of Object.entries({
    operations: 4,
    completed_runs: 2,
    model_requests: 4,
    history_replay_model_calls: 0,
    restored_tool_calls: 1,
    database_count: 7,
    persistent_volumes: 2,
    encryption_keys: 3,
    permission_drift_probes: 2,
  }))
    assert.equal(result[field], count, field);
  for (const field of [
    "event_history_preserved",
    "execution_audits_preserved",
    "deleted_before_teardown",
    "original_acp_ciphertext_read",
    "file_metadata_preserved",
    "replaced_postgres",
    "private_cleanup_completed",
  ])
    assert.equal(result[field], true, field);
  assert.deepEqual(
    Object.keys(result.database_fingerprints).sort(),
    [...databases].sort(),
  );
  assert.deepEqual(result.private_collection_errors, []);
  const work = result.private_restore,
    connections = result.private_connections,
    requests = result.request_traces ?? [];
  assert.equal(work.states.length, 2);
  const [initial, enabled] = work.states;
  assert.notEqual(initial.container.Id, enabled.container.Id);
  assert.equal(initial.volume, enabled.volume);
  assert.notEqual(
    initial.agent.executable_execution_revision,
    enabled.agent.executable_execution_revision,
  );
  assert.equal(work.logins.length, 2);
  assert.equal(work.delegations.length, 2);
  assert.equal(connections.length, 2);
  if (requireTrace) assert.equal(requests.length, 8);
  connections.forEach((connection) =>
    checkPrivateACPConnection(
      requireTrace
        ? connection
        : {
            ...connection,
            connectionTraceID: undefined,
            clientSpanID: undefined,
            initialization: {
              ...connection.initialization,
              connectionTraceID: undefined,
              clientSpanID: undefined,
            },
            evidence: connection.evidence.map((row) => ({
              ...row,
              connectionTraceID: undefined,
              clientSpanID: undefined,
            })),
          },
    ),
  );
  if (requireTrace) unique(connections.map((c) => c.connectionTraceID));
  if (requireTrace) unique(connections.map((c) => c.clientSpanID));
  if (requireTrace) unique(work.logins.map((login) => login.trace_id));
  unique(work.logins.map((login) => login.session_digest));
  assert.deepEqual(work.logins[0].principal, work.logins[1].principal);
  for (const [i, login] of work.logins.entries()) {
    assert.equal(login.status, 200);
    if (requireTrace) assert.match(login.trace_id, /^[a-f0-9]{32}$/u);
    assert.match(login.session_digest, /^[a-f0-9]{64}$/u);
    assertRestoreOwner(
      login.principal,
      work.creation_principal,
      work.states[i].agent,
      result.agent_id,
    );
    assert.deepEqual(work.delegations[i], {
      login_index: i,
      session_digest: login.session_digest,
      connection_trace_id: connections[i].connectionTraceID,
    });
  }
  assert.deepEqual(work.pre_restore_connections, [connections[0]]);
  assertRestoreTransportContinuity(work.transport_before, work.transport_after);
  assert.equal(work.transport_before.project, result.project);
  const sessions = connections[0].evidence
    .slice(0, 2)
    .map((row) => row.sessionId);
  unique(sessions);
  assert.equal(work.runs.length, 2);
  unique(work.runs.map((run) => run.run_id));
  work.runs.forEach((run, i) =>
    assertRestoreRun([run], work.states[i].agent, sessions[i]),
  );
  assert.equal(work.preserved_runs.length, 3);
  for (const run of work.preserved_runs) assert.deepEqual(run, work.runs[0]);
  assert.equal(work.histories.length, 2);
  assert.deepEqual(work.histories[0], work.histories[1]);
  assert.equal(result.history_events, work.histories[0].length);
  assert(
    work.histories[0].some(
      (event) => event.update.sessionUpdate === "tool_call",
    ),
  );
  assert(work.histories[0].every((event) => event.sessionId === sessions[0]));
  assert(
    JSON.stringify(work.histories[0]).includes("c5-before-backup completed"),
  );
  let index = 0;
  const providers = [];
  for (const [i, connection] of connections.entries()) {
    assert.equal(connection.version, 1);
    assert.equal(connection.agentId, result.agent_id);
    assert.deepEqual(
      connection.evidence.map((r) => r.method),
      i === 0
        ? ["session/new", "session/new", "session/prompt", "session/load"]
        : ["session/load", "session/prompt"],
    );
    for (const [j, row] of [
      connection.initialization,
      ...connection.evidence,
    ].entries()) {
      const trace = requests[index++],
        ordinary = row.method === "session/prompt";
      if (requireTrace) {
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
        assert.equal(trace.runs, ordinary ? 1 : 0);
        assert.equal(trace.runtime_tool_calls, ordinary ? 1 : 0);
      }
      assert.equal(row.kind, ordinary ? "ordinary" : "request");
      assert.equal(row.rejection, undefined);
      assert.equal(row.rejectionReceipt, undefined);
      if (requireTrace) assert.equal(trace.rejection, undefined);
      assert.equal(row.outcome, "succeeded");
      if (row.method === "initialize") continue;
      const session =
        i === 0
          ? j === 2
            ? sessions[1]
            : sessions[0]
          : j === 1
            ? sessions[0]
            : sessions[1];
      assert.equal(row.sessionId, session);
      assert.equal(
        row.inputSessionID,
        row.method === "session/new" ? null : session,
      );
      const wire = connection.raw_frames.filter(
        (f) =>
          String(f.id) === row.requestId &&
          (Object.hasOwn(f, "result") || Object.hasOwn(f, "error")),
      );
      assert.equal(wire.length, 1);
      assert.equal(wire[0].error, undefined);
      assert.deepEqual(wire[0].result, row.requestResult);
      assert.deepEqual(row.requestReceipt, {
        requestId: row.requestId,
        params: row.requestParams,
        result: row.requestResult,
      });
      if (!ordinary) {
        assert.deepEqual(row.requestParams, {
          ...(row.method === "session/load" ? { sessionId: session } : {}),
          cwd: "/workspace",
          mcpServers: [],
        });
        continue;
      }
      const phase = i === 0 ? "c5-before-backup" : "c5-after-restore";
      assert.equal(row.phase, phase);
      assert.equal(row.toolName, i === 0 ? "bash" : "read");
      assert.deepEqual(row.requestParams, {
        sessionId: session,
        prompt: [{ type: "text", text: phase }],
      });
      assert.equal(row.requestResult.stopReason, "end_turn");
      if (requireTrace) assert.equal(trace.run_id, work.runs[i].run_id);
      providers.push(
        ...["tool", "reply"].map((stage) => ({
          phase,
          stage,
          ...(requireTrace ? { trace_id: trace.trace_id } : {}),
        })),
      );
    }
  }
  assert.equal(index, 8);
  assert.equal(work.before_model.length, 2);
  assert.equal(work.after_model.length, 2);
  assert.deepEqual(work.provider_requests, [
    ...work.before_model,
    ...work.after_model,
  ]);
  assert.deepEqual(
    work.provider_requests.map(({ phase, stage, trace_id }) => ({
      phase,
      stage,
      ...(requireTrace ? { trace_id } : {}),
    })),
    providers,
  );
  const admissions = work.lifecycle_admissions;
  assert.equal(admissions.length, 4);
  if (requireTrace) assert.equal(result.traces.length, 4);
  assert.deepEqual(
    admissions.map((r) => [r.agentID, r.kind]),
    ["create", "disable", "enable", "delete"].map((kind) => [
      result.agent_id,
      kind,
    ]),
  );
  unique(admissions.map((r) => r.requestID));
  if (requireTrace)
    for (const [i, receipt] of admissions.entries()) {
      const trace = result.traces[i];
      assert.deepEqual(
        [trace.trace_id, trace.agent_id, trace.request_id, trace.kind],
        [receipt.traceID, receipt.agentID, receipt.requestID, receipt.kind],
      );
      assert.equal(trace.topology, "passed");
    }
  const inventory = {
    connections: 2,
    initializations: 2,
    business_requests: 6,
    runs: 2,
    provider_requests: 4,
    runtime_tool_calls: 2,
    lifecycle_admissions: 4,
    login_sessions: 2,
    databases: 7,
    persistent_volumes: 2,
    encryption_keys: 3,
  };
  if (!requireTrace) return { inventory };
  unique([...requests, ...result.traces].map((r) => r.trace_id));
  const diagnostics = restorePrivateOutcome(requests),
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
      strict === 1 || diagnostics.exit_code === 1
        ? 1
        : Math.max(strict, diagnostics.exit_code),
    accepted_exit: lifecycle && diagnostics.accepted ? 0 : 1,
    private_diagnostics: diagnostics,
    inventory,
  };
}
