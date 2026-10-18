import assert from "node:assert/strict";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
import { clockSkewWarning } from "../../support/strict-findings.mjs";
import { assertEmptySession } from "../identity-closeout/acp-session-evidence.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";
import { foundationTraceExitCode } from "./foundation-evidence.mjs";
import { assertRestoreOwner } from "./restore-private-session.mjs";
import { assertRestoreTransportContinuity } from "./restore-private-transport.mjs";
import { restorePrivateOutcome } from "./restore-private-trace.mjs";
import {
  assertStopped,
  assertRestarted,
  assertIdleMaintenance,
} from "./shutdown-evidence.mjs";
import {
  assertShutdownPrivateWatchReceipt,
  shutdownACPStop,
  shutdownPrivateWatchOutcome,
} from "./shutdown-private-trace.mjs";
import { inspectSingleNodeMembership } from "./temporal-membership.mjs";
import { physicalIdentity } from "./network-support.mjs";

function unique(values) {
  assert(
    values.every((value) => typeof value === "string" && value.length > 0),
  );
  assert.equal(
    new Set(values).size,
    values.length,
    "duplicate Shutdown identity",
  );
}
export function shutdownPublicResult(result) {
  const {
    private_shutdown,
    private_connections,
    private_state_watches,
    private_collection_errors,
    private_cleanup_completed,
    stop_observation,
    restarted_inventory,
    acp_remote_close,
    ...publicResult
  } = result;
  return publicResult;
}
export function shutdownPrivateAdmission(result) {
  assert.equal(result.profile, "shutdown");
  for (const [key, value] of Object.entries({
    operations: 2,
    watches_closed_by_server: 2,
    acp_close_code: 1001,
    execution_audits: 0,
    model_requests: 0,
    workspace: "retained",
    runtime: "unchanged",
    same_session_recovered: true,
    event_history_preserved: true,
    deleted_before_teardown: true,
    private_cleanup_completed: true,
  }))
    assert.equal(result[key], value, key);
  assert.deepEqual(result.private_collection_errors, []);
  const work = result.private_shutdown,
    connections = result.private_connections,
    states = result.private_state_watches,
    requests = result.request_traces,
    watches = result.watch_traces;
  assert.equal(work.states.length, 2);
  assert.equal(work.logins.length, 1);
  assert.equal(work.delegations.length, 4);
  assert.equal(connections.length, 2);
  assert.equal(states.length, 2);
  assert.equal(requests.length, 4);
  assert.equal(watches.length, 2);
  const login = work.logins[0];
  assert.equal(login.status, 200);
  assert.match(login.trace_id, /^[a-f0-9]{32}$/u);
  assert.match(login.session_digest, /^[a-f0-9]{64}$/u);
  for (const state of work.states)
    assertRestoreOwner(
      login.principal,
      work.creation_principal,
      state.agent,
      result.agent_id,
    );
  assert.deepEqual(
    physicalIdentity(work.states[0]),
    physicalIdentity(work.states[1]),
    "Shutdown replaced its live Runtime or execution binding",
  );
  assert.equal(work.workspace.path, "/workspace/.c5-stop-sentinel");
  assert(
    typeof work.workspace.before === "string" &&
      work.workspace.before.length > 0,
  );
  assert.equal(work.workspace.after, work.workspace.before);
  assert.equal(work.deletion.agent.agent_id, result.agent_id);
  assert.equal(work.deletion.agent.lifecycle_state, "deleted");
  assert.deepEqual(work.deletion.resources, { containers: [], volumes: [] });
  assertRestoreTransportContinuity(work.transport_before, work.transport_after);
  assert.equal(work.transport_before.project, result.project);
  assert.deepEqual(work.stop, result.stop_observation);
  assert.deepEqual(work.stop_window, result.stop_window);
  assert.deepEqual(work.platform_inventory, {
    initial: work.stop.before,
    stopped: work.stop.after,
    restarted: result.restarted_inventory,
  });
  const stop = shutdownACPStop({
    stop: work.stop,
    stopWindow: work.stop_window,
  });
  assert.equal(work.stop.project, result.project);
  assert.deepEqual(
    result.stopped,
    assertStopped(result.project, work.stop.before, work.stop.after),
  );
  assert.deepEqual(
    result.restarted,
    assertRestarted(
      result.project,
      work.stop.before,
      result.restarted_inventory,
    ),
  );
  const restartedACP = result.restarted_inventory.find(
    (row) => row.name === "agent-acp-service",
  );
  assert.equal(restartedACP.hostname, stop.before.hostname);
  assert.deepEqual(restartedACP.process, stop.before.process);
  for (const phase of ["initial", "restarted"])
    assert.deepEqual(
      result.temporal_membership[phase],
      inspectSingleNodeMembership(work.membership_logs[phase]),
    );
  const remote = work.remote_acp_close;
  assert.deepEqual(remote, result.acp_remote_close);
  assert.equal(remote.code, 1001);
  assert.equal(remote.localClose, false);
  assert.equal(typeof remote.reason, "string");
  assert(
    Number.isSafeInteger(remote.at) &&
      remote.at >= work.stop.startedAt &&
      remote.at <= work.stop_window.end,
  );
  assert.equal(work.remote_acp_connection, connections[0].connectionTraceID);
  assert.equal(work.idle.length, 2);
  for (const row of work.idle) assertIdleMaintenance(row.audits, row.model);
  assert.deepEqual(work.final_model, { requests: [], errors: [] });
  assert.equal(work.histories.length, 2);
  assert.deepEqual(work.histories[0], work.histories[1]);
  assert(
    Array.isArray(work.histories[0].events) &&
      work.histories[0].events.length < 100,
  );
  const session = connections[0].evidence[0].sessionId;
  assert(typeof session === "string" && session.length > 0);
  connections.forEach(checkPrivateACPConnection);
  unique(connections.map((connection) => connection.connectionTraceID));
  unique(connections.map((connection) => connection.clientSpanID));
  let requestIndex = 0;
  for (const [i, connection] of connections.entries()) {
    assert.equal(connection.version, 1);
    assert.equal(connection.agentId, result.agent_id);
    assert.deepEqual(
      connection.evidence.map((row) => row.method),
      [i ? "session/load" : "session/new"],
    );
    assertEmptySession(connection.updates, session, 1, i ? "replay" : "new");
    assert.deepEqual(
      connection.raw_frames
        .filter((frame) => frame.method === "session/update")
        .map((frame) => frame.params),
      connection.updates,
      "original Session notification evidence missing",
    );
    for (const row of [connection.initialization, ...connection.evidence]) {
      assert.equal(row.kind, "request");
      assert.equal(row.outcome, "succeeded");
      assert.equal(row.rejection, undefined);
      assert.equal(row.rejectionReceipt, undefined);
      const trace = requests[requestIndex++];
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
      assert.equal(trace.runs, 0);
      assert.equal(trace.runtime_tool_calls, 0);
      assert.equal(trace.rejection, undefined);
      const raw = connection.raw_frames.filter(
        (frame) =>
          Object.hasOwn(frame, "id") &&
          String(frame.id) === row.requestId &&
          Object.hasOwn(frame, "result"),
      );
      assert.equal(raw.length, 1);
      if (row.method === "initialize") {
        assert.deepEqual(raw[0].result, row.initializationResult);
        continue;
      }
      assert.equal(row.sessionId, session);
      assert.equal(row.inputSessionID, i ? session : null);
      assert.deepEqual(row.requestParams, {
        ...(i ? { sessionId: session } : {}),
        cwd: "/workspace",
        mcpServers: [],
      });
      assert.deepEqual(raw[0].result, row.requestResult);
      assert.deepEqual(row.requestReceipt, {
        requestId: row.requestId,
        params: row.requestParams,
        result: row.requestResult,
      });
    }
  }
  assert.deepEqual(connections[1].updates, connections[0].updates);
  assert.deepEqual(
    work.delegations.map(({ kind, trace_id }) => ({ kind, trace_id })),
    [
      { kind: "state", trace_id: states[0].traceID },
      { kind: "acp", trace_id: connections[0].connectionTraceID },
      { kind: "acp", trace_id: connections[1].connectionTraceID },
      { kind: "state", trace_id: states[1].traceID },
    ],
  );
  for (const row of work.delegations) {
    assert.deepEqual(row.principal, login.principal);
    assert.equal(row.session_digest, login.session_digest);
  }
  unique(states.map((row) => row.traceID));
  unique(states.map((row) => row.clientSpanID));
  for (const [i, receipt] of states.entries())
    assertShutdownPrivateWatchReceipt(
      receipt,
      {
        agentID: result.agent_id,
        principal: login.principal,
        session_digest: login.session_digest,
        traceID: receipt.traceID,
        clientSpanID: receipt.clientSpanID,
      },
      i === 0,
    );
  assert.deepEqual(states[1].events[0], states[0].events[0]);
  assert.equal(work.public_watches.length, 2);
  for (const [i, watch] of work.public_watches.entries()) {
    assert.equal(watch.joined, true);
    assert.equal(watch.closure.kind, i ? "local-close" : "transport-end");
    assert.equal(watch.closure.traceID, watch.traceID);
    assert(watch.events.length > 0 && watch.events.length < 100);
    assert.equal(watch.closure.receivedEvents, watch.events.length);
    for (const event of watch.events)
      assert.equal(event.agent_id, result.agent_id);
    assert(Array.isArray(watch.transport_diagnostics));
    assert(watch.transport_diagnostics.length <= (i ? 0 : 1));
    for (const diagnostic of watch.transport_diagnostics) {
      assert.equal(diagnostic.traceID, watch.traceID);
      assert.equal(diagnostic.reason, "shutdown-public-remote-socket-end");
      assert.equal(diagnostic.name, "TypeError");
      assert.equal(diagnostic.message, "terminated");
      assert.equal(diagnostic.cause_code, "UND_ERR_SOCKET");
      assert.equal(diagnostic.cause_message, "other side closed");
      assert(
        typeof diagnostic.raw_error === "string" &&
          diagnostic.raw_error.length > 0,
      );
      assert(
        Number.isSafeInteger(diagnostic.observedAt) &&
          diagnostic.observedAt >= work.stop.startedAt &&
          diagnostic.observedAt <= watch.closure.observedAt,
      );
      assert(
        watches[0].cancellation_error_spans > 0,
        "remote socket termination requires the original cancellation Trace",
      );
    }
  }
  assert.deepEqual(
    work.public_watches[1].events[0],
    work.public_watches[0].events[0],
  );
  assert.deepEqual(result.watch_closures, [
    work.public_watches[0].closure,
    states[0].closure,
  ]);
  for (const [i, trace] of watches.entries()) {
    assert.equal(trace.topology, "passed");
    assert.equal(trace.remote_closure_verified, true);
    assert.equal(trace.stop_window_verified, true);
    assert.equal(
      trace.trace_id,
      i ? states[0].traceID : work.public_watches[0].traceID,
    );
    assert.deepEqual(trace.closure, result.watch_closures[i]);
    assert(
      trace.closure.observedAt >= work.stop.startedAt &&
        trace.closure.observedAt <= work.stop_window.end,
    );
  }
  assert.equal(watches[1].client_span_id, states[0].clientSpanID);
  assert.equal(watches[1].agent_id, result.agent_id);
  const stateWatch = watches[1];
  assert.equal(stateWatch.kind, "private_state_watch");
  assert.match(stateWatch.server_span_id, /^[a-f0-9]{16}$/u);
  assert.equal(stateWatch.strict_trace, "failed");
  assert.equal(stateWatch.error_spans, 1);
  const originalError = {
    trace_id: stateWatch.trace_id,
    span_id: stateWatch.server_span_id,
  };
  assert.deepEqual(stateWatch.raw_error_inventory, [originalError]);
  assert.deepEqual(stateWatch.owned_error_spans, [
    { ...originalError, reason: "shutdown-private-state-process-shutdown" },
  ]);
  const event = watches[0];
  assert.equal(event.gateway_ancestry, true);
  assert.equal(event.resolve_source_error_spans, 0);
  assert(Number.isSafeInteger(event.error_spans) && event.error_spans >= 0);
  assert.equal(event.error_spans, event.cancellation_error_spans);
  assert(
    Number.isSafeInteger(event.warning_count) &&
      event.warning_count >= event.warnings.length,
  );
  assert.equal(event.warning_count === 0, event.warnings.length === 0);
  assert.equal(
    event.strict_trace,
    event.error_spans || event.warning_count ? "failed" : "passed",
  );
  const lifecycle = work.lifecycle_admissions;
  assert.equal(lifecycle.length, 2);
  assert.equal(result.traces.length, 2);
  assert.deepEqual(
    lifecycle.map((row) => [row.kind, row.agentID]),
    [
      ["create", result.agent_id],
      ["delete", result.agent_id],
    ],
  );
  unique(lifecycle.map((row) => row.requestID));
  for (const [i, row] of lifecycle.entries()) {
    const trace = result.traces[i];
    assert.equal(trace.topology, "passed");
    assert.deepEqual(
      [trace.trace_id, trace.agent_id, trace.request_id, trace.kind],
      [row.traceID, row.agentID, row.requestID, row.kind],
    );
    assert.equal(trace.rejection, undefined);
    assert.equal(trace.restart_error_spans ?? 0, 0);
    assert.equal(trace.expected_transport_faults ?? 0, 0);
  }
  const all = [...requests, ...watches, ...result.traces];
  unique(all.map((trace) => trace.trace_id));
  const requestOutcome = restorePrivateOutcome(requests),
    watchOutcome = shutdownPrivateWatchOutcome([watches[1]]);
  return {
    strict_exit: foundationTraceExitCode(all),
    accepted_exit:
      requestOutcome.accepted &&
      watchOutcome.accepted &&
      clockWarningsOnly(result.traces) &&
      event.warnings.every(
        (warning) =>
          typeof warning === "string" && clockSkewWarning.test(warning),
      )
        ? 0
        : 1,
    private_diagnostics: {
      requests: requestOutcome,
      state_watch: watchOutcome,
    },
    inventory: {
      connections: 2,
      initializations: 2,
      business_requests: 2,
      login_sessions: 1,
      private_state_watches: 2,
      maintenance_watch_closures: 2,
      lifecycle_admissions: 2,
      runs: 0,
      provider_requests: 0,
      runtime_tool_calls: 0,
    },
  };
}
