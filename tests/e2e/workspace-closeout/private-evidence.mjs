import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
import { assertAgentDisabled } from "../../support/verification/agent-state.mjs";
import { assertRestoreOwner } from "../lifecycle-closeout/restore-private-session.mjs";
import {
  assertCompletedExecution,
  foundationTraceExitCode,
} from "../lifecycle-closeout/foundation-evidence.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";
import {
  assertCancelledRun,
  assertUnchangedAudit,
  runtimeBinding,
} from "./current-evidence.mjs";
import { groupAlive, processStat } from "./process.mjs";
import {
  projectWorkspaceRequest,
  workspaceRequestKey,
} from "./private-requests.mjs";
import { assertWorkspaceStateReceipt } from "./private-http-trace.mjs";
import { assertWorkspaceWatchReceipt } from "./private-watch.mjs";
import { assertWorkspaceAuthorityReceipt } from "./private-authority-trace.mjs";
import { workspacePrivateTraceOutcome } from "./private-diagnostics.mjs";

const unique = (values) =>
  assert.equal(
    new Set(values).size,
    values.length,
    "duplicate Workspace identity",
  );
const nonempty = (value) =>
  assert(typeof value === "string" && value.length > 0);
const equal = assert.deepEqual;
const phases = ["c4-cancel", "c4-offline", "c4-rebuilt"];

// Collectors already verify the archived query bytes. Admission binds that
// receipt to this request's complete sources and all three stable samples.
function completeSource(report, transport, sources) {
  const receipt = report.complete_source_receipt;
  assert(receipt, "complete Workspace source receipt required");
  assert.equal(receipt.version, 1);
  assert.equal(receipt.transport, transport);
  assert.equal(receipt.stable_samples, 3);
  assert.equal(receipt.samples.length, 3);
  unique(receipt.source_trace_ids);
  for (const id of receipt.source_trace_ids)
    assert.match(id, /^[a-f0-9]{32}$/u);
  equal(new Set(receipt.source_trace_ids), new Set(sources));
  assert.match(receipt.source_snapshot_sha256, /^[a-f0-9]{64}$/u);
  const files = new Set();
  for (const [index, sample] of receipt.samples.entries()) {
    assert(Number.isSafeInteger(sample.attempt) && sample.attempt > 0);
    if (index)
      assert.equal(sample.attempt, receipt.samples[index - 1].attempt + 1);
    assert.match(sample.snapshot_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(sample.snapshot_sha256, receipt.samples[0].snapshot_sha256);
    assert.equal(sample.source_snapshot_sha256, receipt.source_snapshot_sha256);
    equal(sample.source_trace_ids, receipt.source_trace_ids);
    assert(sample.queries.length > 0);
    for (const query of sample.queries) {
      assert.equal(query.attempt, sample.attempt);
      assert.match(query.file, /^query-\d{4,}\.raw$/u);
      assert(!files.has(query.file));
      files.add(query.file);
      assert.equal(query.status, 200);
      assert.equal(query.outcome, "complete");
      assert.equal(query.body_complete, true);
      assert(Number.isSafeInteger(query.bytes) && query.bytes > 0);
      assert.match(query.sha256, /^[a-f0-9]{64}$/u);
    }
  }
}

function ownedDiagnostics(report, expected) {
  equal(new Set(report.owned_error_spans), new Set(expected));
  equal(
    new Set(report.raw_error_inventory),
    new Set(expected.map(({ trace_id, span_id }) => ({ trace_id, span_id }))),
  );
}

function businessProof(work, agentID, sessions, prompts, reports) {
  const { cancel, offline, rebuilt, revocation, deleted } = work.business;
  equal(Object.keys(work.business).sort(), [
    "cancel",
    "deleted",
    "offline",
    "rebuilt",
    "revocation",
  ]);
  assert.equal(work.bindings.length, 3);
  const observed = [cancel.before, offline.before, rebuilt.observed];
  equal(cancel.after, offline.before);
  equal(offline.after, rebuilt.observed);
  equal(work.initial_agent, cancel.before.agent);
  for (const [index, entry] of work.bindings.entries()) {
    equal(entry.observed, observed[index]);
    equal(entry.binding, runtimeBinding(entry.observed, entry.status));
    equal(prompts[index].runtime, entry.binding);
    assert.equal(observed[index].agent.agent_id, agentID);
  }
  unique(observed.map((row) => row.container.Id));
  unique(work.bindings.map((row) => row.binding.runtime_revision));
  unique(work.bindings.map((row) => row.binding.runtime_execution_id));
  for (const replacement of [cancel, offline]) {
    nonempty(replacement.before.volume);
    assert.equal(replacement.after.volume, replacement.before.volume);
    assert.notEqual(
      replacement.after.container.Id,
      replacement.before.container.Id,
    );
    assert.notEqual(
      replacement.after.agent.runtime.runtime_revision,
      replacement.before.agent.runtime.runtime_revision,
    );
  }
  assert.match(cancel.pid, /^[1-9][0-9]*$/u);
  const process = processStat(cancel.pid_stat);
  assert.equal(process.pid, Number(cancel.pid));
  assert.equal(process.group, cancel.pgid);
  assert(groupAlive(cancel.process_before, cancel.pgid));
  assert(!groupAlive(cancel.process_after, cancel.pgid));
  assert.equal(cancel.effects, "started\n");
  assert.equal(cancel.recovered_effects, cancel.effects);
  assert.equal(offline.effects, "started\nfinished\n");
  assert.equal(offline.rebuilt_effects, offline.effects);
  const audits = [cancel.audit, offline.audit, rebuilt.audit];
  assertCancelledRun(
    audits[0].run,
    agentID,
    sessions[0],
    observed[0].agent.executable_execution_revision,
  );
  assertCompletedExecution(audits[1].run, observed[1].agent);
  assertCompletedExecution(audits[2].run, observed[2].agent);
  for (const [index, audit] of audits.entries()) {
    equal(prompts[index].run, audit.run);
    assert.equal(prompts[index].runId, audit.run.run_id);
    assert.equal(audit.run.session_id, sessions[index ? 1 : 0]);
    assert.equal(audit.events.next_cursor, null);
  }
  unique(audits.map((audit) => audit.run.run_id));
  assertUnchangedAudit(cancel.audit, cancel.recovery_audit);
  assertUnchangedAudit(cancel.audit, rebuilt.cancelled_audit);
  assertUnchangedAudit(offline.audit, offline.replay_audit);
  assertUnchangedAudit(offline.audit, rebuilt.offline_audit);
  for (const [before, after] of [
    [cancel.recovery_before, cancel.recovery_after],
    [offline.audit_before, offline.audit_after],
    [revocation.audit_before, revocation.audit_after],
  ]) {
    assert.equal(before.next_cursor, null);
    equal(after, before);
  }
  assert.equal(cancel.recovery_before.items.length, 1);
  assert.equal(offline.audit_before.items.length, 2);
  assert.equal(rebuilt.audit_page.next_cursor, null);
  equal(
    rebuilt.audit_page.items.map((row) => row.run_id).sort(),
    audits.map((audit) => audit.run.run_id).sort(),
  );
  equal(revocation.audit_before, rebuilt.audit_page);
  assert.equal(offline.replay_answer, "c4-offline completed");
  assert.equal(rebuilt.answer, "c4-rebuilt completed");
  assert.equal(rebuilt.reply.stopReason, "end_turn");
  const providers = work.final_model.requests;
  equal(work.final_model.errors, []);
  equal(
    providers.map((row) => [row.phase, row.stage, row.trace_id]),
    [
      [phases[0], "tool", reports[0].trace_id],
      [phases[1], "tool", reports[1].trace_id],
      [phases[1], "reply", reports[1].trace_id],
      [phases[2], "tool", reports[2].trace_id],
      [phases[2], "reply", reports[2].trace_id],
    ],
  );
  for (const row of providers)
    assert.match(row.model_span_id, /^[a-f0-9]{16}$/u);
  unique(providers.map((row) => row.model_span_id));
  equal(cancel.model_before, providers.slice(0, 1));
  equal(cancel.model_after_busy, cancel.model_before);
  equal(cancel.model_after_barrier, cancel.model_before);
  equal(offline.model_before, providers.slice(0, 3));
  equal(offline.model_after, offline.model_before);
  equal(rebuilt.model, providers);
  equal(revocation.model_before, providers);
  equal(revocation.model_after, providers);
  assertAgentDisabled(revocation.disabled_agent);
  assert.equal(revocation.disabled_agent.agent_id, agentID);
  equal(
    [...revocation.resources.volumes].sort(),
    [rebuilt.observed.volume, rebuilt.observed.skillVolume].sort(),
  );
  assert(
    revocation.resources.containers.every(
      (container) => !container.State.Running,
    ),
  );
  assert.equal(revocation.network.attachment.state, "closed");
  equal(deleted.resources, { containers: [], volumes: [] });
}

export function workspacePrivateAdmission(result) {
  assert.equal(result.profile, "workspace-protocol");
  for (const key of [
    "cross_connection_cancel",
    "unknown_run_immutable",
    "contention_rejected",
    "replay_without_effects",
    "rebuild_observed",
    "revocation_observed",
    "deleted_before_teardown",
    "private_cleanup_completed",
  ])
    assert.equal(result[key], true, key);
  assert.equal(result.completed_prompts, 2);
  assert.equal(result.model_requests, 5);
  assert.equal(result.cancel_recovery, "explicit_rebuild");
  equal(result.private_collection_errors, []);
  if (result.workspaceErrors) equal(result.workspaceErrors, []);
  const work = result.private_workspace,
    connections = result.private_connections;
  assert.equal(work.logins.length, 1);
  const login = work.logins[0];
  assert.equal(login.status, 200);
  assert.match(login.trace_id, /^[a-f0-9]{32}$/u);
  assert.match(login.session_digest, /^[a-f0-9]{64}$/u);
  assertRestoreOwner(
    login.principal,
    work.creation_principal,
    work.initial_agent,
    result.agent_id,
  );
  assert.equal(connections.length, 5);
  connections.forEach(checkPrivateACPConnection);
  unique(connections.map((row) => row.connectionTraceID));
  unique(connections.map((row) => row.clientSpanID));
  const [first, second] = connections[0].evidence.map((row) => row.sessionId);
  nonempty(first);
  nonempty(second);
  assert.notEqual(first, second);
  const methods = [
    ["session/new", "session/new", "session/prompt"],
    ["session/load", "session/prompt", "session/prompt"],
    ["session/load", "session/prompt"],
    ["session/load"],
    ["session/load", "session/prompt", "session/prompt"],
  ];
  const sessions = [
    [first, second, first],
    [second, second, second],
    [second, second],
    [second],
    [second, second, second],
  ];
  assert.equal(work.observations.length, 12);
  unique(work.observations.map(workspaceRequestKey));
  const notes = new Map(
    work.observations.map((row) => [workspaceRequestKey(row), row]),
  );
  const rows = connections.flatMap((connection, index) => {
    assert.equal(connection.version, 1);
    assert.equal(connection.agentId, result.agent_id);
    equal(
      connection.evidence.map((row) => row.method),
      methods[index],
    );
    equal(
      connection.evidence.map((row) => row.sessionId),
      sessions[index],
    );
    equal(
      connection.raw_frames
        .filter((frame) => frame.method === "session/update")
        .map((frame) => frame.params),
      connection.updates,
    );
    return [connection.initialization, ...connection.evidence].map((row) => {
      const note = notes.get(workspaceRequestKey(row));
      assert.equal(Boolean(note), row.method !== "initialize");
      return projectWorkspaceRequest(connection, row, note);
    });
  });
  assert.equal(rows.length, 17);
  equal(
    rows.filter((row) => row.phase).map((row) => row.phase),
    phases,
  );
  equal(
    rows.filter((row) => row.rejection).map((row) => row.rejection),
    ["agent_busy", "runtime_barrier_required", "access_denied"],
  );
  equal(
    rows.filter((row) => row.probe).map((row) => row.rejection),
    ["access_denied"],
  );
  assert.equal(rows.at(-1).probe, true);
  const requests = result.request_traces;
  assert.equal(requests.length, rows.length);
  const prompts = [],
    promptReports = [];
  for (const [index, row] of rows.entries()) {
    const report = requests[index];
    assert.notEqual(report.topology, "failed");
    equal(
      [
        report.kind,
        report.method,
        report.request_id,
        report.connection_trace_id,
        report.session_id,
        report.agent_id,
      ],
      [
        row.kind,
        row.method,
        row.requestId,
        row.connectionTraceID,
        row.sessionId,
        result.agent_id,
      ],
    );
    completeSource(report, "websocket", [
      report.trace_id,
      row.connectionTraceID,
    ]);
    if (row.phase) {
      assert.equal(report.run_id, row.runId);
      assert.equal(report.runs, 1);
      assert.equal(report.runtime_tool_calls, 1);
      if (row.phase !== "c4-rebuilt")
        assert.equal(report.disconnect_verified, true);
      prompts.push(row);
      promptReports.push(report);
    } else if (row.rejection === "runtime_barrier_required") {
      assert.equal(report.barrier_rejection, true);
      assert.equal(report.model_requests, 0);
      assert.equal(report.sql_spans, 5);
    } else {
      assert.equal(report.runs, 0);
      assert.equal(report.rejection, row.rejection);
      if (row.rejection) assert.equal(report.no_execution, true);
      if (row.rejection !== "agent_busy")
        assert.equal(report.runtime_tool_calls, 0);
    }
  }
  businessProof(work, result.agent_id, [first, second], prompts, promptReports);
  const disconnects = result.private_disconnects;
  assert.equal(disconnects.length, 2);
  equal(
    connections.flatMap((connection) => connection.deliberate_disconnects),
    disconnects,
  );
  for (const [index, receipt] of disconnects.entries()) {
    const row = prompts[index],
      connection = connections[index ? 2 : 0];
    for (const key of [
      "boundary",
      "transport",
      "protocolVersion",
      "agentId",
      "connectionTraceID",
      "clientSpanID",
      "requestId",
      "method",
      "inputSessionID",
      "sessionId",
      "phase",
    ])
      equal(receipt[key], row[key]);
    assert.equal(receipt.original_local_close_error, true);
    assert.equal(receipt.response_absent, true);
    equal(receipt.close, connection.close_receipt);
    assert.equal(receipt.close.localClose, true);
    assert([1000, 1005].includes(receipt.close.code));
    assert(
      Number.isFinite(receipt.started_at) &&
        Number.isFinite(receipt.close.at) &&
        receipt.close.at >= receipt.started_at,
    );
  }
  assert.equal(work.held_results.length, 3);
  for (const row of work.held_results.slice(0, 2)) nonempty(row.error);
  assert.equal(work.held_results[2].value.stopReason, "end_turn");
  const notifications = result.private_notifications;
  assert.equal(notifications.length, 1);
  equal(
    connections.flatMap((connection) => connection.notifications),
    notifications,
  );
  const notification = notifications[0];
  for (const key of ["requestId", "id", "request_id"])
    assert.equal(notification[key], undefined);
  equal(
    [
      notification.method,
      notification.sessionId,
      notification.connectionTraceID,
      notification.clientSpanID,
      notification.agentId,
    ],
    [
      "session/cancel",
      first,
      connections[1].connectionTraceID,
      connections[1].clientSpanID,
      result.agent_id,
    ],
  );
  assert.equal(notification.origin, "notify");
  assert.equal(notification.status, "write_completed");
  assert.equal(notification.wireObserved, true);
  assert.equal(notification.writeOutcome, "completed");
  assert.equal(result.notification_traces.length, 1);
  const cancel = result.notification_traces[0];
  assert.notEqual(cancel.topology, "failed");
  equal(
    [
      cancel.kind,
      cancel.method,
      cancel.session_id,
      cancel.connection_trace_id,
      cancel.request_id,
    ],
    [
      "notification",
      notification.method,
      first,
      notification.connectionTraceID,
      undefined,
    ],
  );
  assert.equal(cancel.cancellation_requested, true);
  assert.equal(cancel.model_requests, 0);
  ownedDiagnostics(cancel, []);
  completeSource(cancel, "websocket", [
    cancel.trace_id,
    notification.connectionTraceID,
  ]);

  const identity = (receipt) => ({
    agentID: result.agent_id,
    principal: login.principal,
    session_digest: login.session_digest,
    traceID: receipt.traceID,
    clientSpanID: receipt.clientSpanID,
  });
  const states = result.private_state_receipts,
    watches = result.private_state_watches;
  assert(states.length > 0);
  assert.equal(result.state_traces.length, states.length);
  assert.equal(watches.length, 2);
  assert.equal(work.watch_windows.length, 2);
  assert.equal(result.watch_traces.length, 2);
  const httpReport = (report, receipt, kind) => {
    equal(
      [
        report.topology,
        report.kind,
        report.trace_id,
        report.client_span_id,
        report.agent_id,
      ],
      ["passed", kind, receipt.traceID, receipt.clientSpanID, result.agent_id],
    );
    assert.match(report.server_span_id, /^[a-f0-9]{16}$/u);
    completeSource(report, "http", [receipt.traceID]);
  };
  for (const [index, receipt] of states.entries()) {
    assertWorkspaceStateReceipt(receipt, identity(receipt));
    httpReport(result.state_traces[index], receipt, "private_state");
    ownedDiagnostics(result.state_traces[index], []);
  }
  const events = watches.map((receipt, index) => {
    const window = work.watch_windows[index];
    assert.equal(window.traceID, receipt.traceID);
    assert.equal(window.mode, index ? "revocation" : "local-close");
    const observed = assertWorkspaceWatchReceipt(receipt, {
      ...identity(receipt),
      ...window,
    });
    const report = result.watch_traces[index];
    httpReport(report, receipt, "private_state_watch");
    equal(report.closure, receipt.closure);
    assert.equal(report.remote_closure_verified, index === 1);
    ownedDiagnostics(
      report,
      index
        ? []
        : [
            {
              trace_id: report.trace_id,
              span_id: report.server_span_id,
              reason: "workspace-private-watch-local-close",
            },
          ],
    );
    return observed;
  });
  let cursor = 0;
  for (const [availability, session, reason] of [
    ["busy", first, null],
    ["offline", null, "runtime_barrier_required"],
    ["ready", null, null],
    ["busy", second, null],
  ]) {
    const index = events[0].findIndex(
      (state, index) =>
        index >= cursor &&
        state.availability === availability &&
        state.active_session_id === session &&
        state.unavailable_reason === reason,
    );
    assert(index >= cursor, "original cancel/recovery watch sequence missing");
    cursor = index + 1;
  }
  const offline = work.business.offline;
  assert.equal(
    offline.before_configuration,
    events[1][0].configuration_revision,
  );
  const unavailableIndex = events[1].findIndex((state) =>
    isDeepStrictEqual(state, offline.unavailable),
  );
  assert(
    unavailableIndex > 0 && offline.unavailable.availability === "offline",
  );
  assert(
    events[1]
      .slice(unavailableIndex + 1)
      .some((state) => isDeepStrictEqual(state, offline.ready)),
  );
  assert.equal(offline.ready.availability, "ready");
  assert.notEqual(
    offline.ready.configuration_revision,
    offline.before_configuration,
  );

  const scopes = result.private_authority_receipts;
  assert.equal(
    scopes.length,
    connections.length + watches.length + states.length + 1,
  );
  assert.equal(result.authority_traces.length, scopes.length);
  equal(
    scopes.map((scope) => scope.operation_id),
    scopes.map((_, index) => index + 1),
  );
  const resources = [...connections, ...watches, ...states];
  unique(resources.map((row) => row.authority_scope));
  assert.equal(work.denied_connections.length, 1);
  equal(work.denied_connections[0], {
    agentID: result.agent_id,
    after: work.watch_windows[1].revocationStart.observedAt,
  });
  for (const [index, scope] of scopes.entries()) {
    assert.equal(scope.receipts.length, 1);
    const receipt = scope.receipts[0],
      denied = scope.kind === "denied-connection";
    const selected = {
      operation_id: scope.operation_id,
      kind: scope.kind,
      index: scope.index,
    };
    if (denied) {
      assert.equal(index, scopes.length - 1);
      assert.equal(scope.index, 6);
      assert.equal(receipt.status, 401);
      assert(
        !resources.some((row) => row.authority_scope === scope.operation_id),
      );
    } else {
      const group = { connection: connections, watch: watches, state: states }[
        scope.kind
      ];
      assert(group);
      const resource = group[scope.index - 1];
      assert(resource && resource.authority_scope === scope.operation_id);
      equal(resource.authority, scope.receipts);
      assert.equal(receipt.status, 200);
    }
    assertWorkspaceAuthorityReceipt(receipt, {
      ...identity(receipt),
      kind: "workspace_identity",
      scope: selected,
      ...(denied ? { after: work.denied_connections[0].after } : {}),
    });
    const report = result.authority_traces[index];
    httpReport(report, receipt, "workspace_identity");
    equal(report.authority_scope, selected);
    assert.equal(report.status, receipt.status);
    assert.equal(report.original_session_verified, true);
    ownedDiagnostics(
      report,
      denied
        ? [
            {
              trace_id: report.trace_id,
              span_id: report.client_span_id,
              reason: "workspace-identity-denied-client",
            },
            {
              trace_id: report.trace_id,
              span_id: report.server_span_id,
              reason: "workspace-identity-denied-server",
            },
          ]
        : [],
    );
  }
  assert.equal(
    scopes.filter((row) => row.kind === "denied-connection").length,
    1,
  );

  assert.equal(result.operations, 4);
  const lifecycle = work.lifecycle_admissions;
  assert.equal(lifecycle.length, 4);
  assert.equal(result.traces.length, 4);
  equal(
    lifecycle.map((row) => row.kind),
    ["create", "rebuild", "rebuild", "delete"],
  );
  equal(
    lifecycle.map((row) => row.settlementOutcome ?? "settled"),
    [
      "settled",
      "runtime_barrier_required",
      "settled",
      "runtime_barrier_required",
    ],
  );
  equal(
    lifecycle.map((row) => row.networkAlreadyClosed ?? false),
    [false, false, false, true],
  );
  unique(lifecycle.map((row) => row.requestID));
  for (const [index, row] of lifecycle.entries()) {
    assert.equal(row.agentID, result.agent_id);
    const report = result.traces[index];
    equal(
      [
        report.topology,
        report.kind,
        report.trace_id,
        report.request_id,
        report.agent_id,
      ],
      ["passed", row.kind, row.traceID, row.requestID, result.agent_id],
    );
  }
  assert.equal(work.offboarding.length, 1);
  assert.equal(result.offboarding_traces.length, 1);
  const offboarding = work.offboarding[0],
    offboard = result.offboarding_traces[0],
    revoked = work.business.revocation;
  assert.equal(offboarding.agentID, result.agent_id);
  equal(revoked.request, {
    path: `/api/admin/directory/users/${login.principal.user_id}/active`,
    body: { active: false },
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(
    revoked.response.headers["x-antnest-trace-id"],
    revoked.response.traceID,
  );
  assert.equal(offboarding.sourceID, revoked.response.traceID);
  assert.equal(offboarding.traceID, offboarding.sourceID);
  assert.equal(offboarding.sourceID, work.watch_windows[1].revocationTraceID);
  assert.equal(offboarding.settlementOutcome, "settled");
  assert(!lifecycle.some((row) => row.requestID === offboarding.requestID));
  assert(
    revoked.before_events.events.length < 100 &&
      revoked.after_events.events.length < 100,
  );
  const added = revoked.after_events.events.filter(
    (event) =>
      !revoked.before_events.events.some(
        (before) => before.event_id === event.event_id,
      ),
  );
  equal(
    added.filter((event) => event.event_type === "agent_owner_revoked"),
    [offboarding.ownerRevocation.event],
  );
  equal(
    added.filter((event) => event.event_type === "agent_disabled"),
    [offboarding.disabledEvent],
  );
  assert.equal(
    offboarding.ownerRevocation.ownerUserID,
    login.principal.user_id,
  );
  assert.equal(offboarding.ownerRevocation.reason, "user_deactivated");
  assert.equal(offboarding.ownerRevocation.organizationID, "");
  assert.notEqual(offboard.topology, "failed");
  equal(
    [
      offboard.kind,
      offboard.trace_id,
      offboard.source_trace_id,
      offboard.request_id,
      offboard.agent_id,
      offboard.settlement_outcome,
    ],
    [
      "disable",
      offboarding.traceID,
      offboarding.sourceID,
      offboarding.requestID,
      result.agent_id,
      "settled",
    ],
  );
  equal(offboard.owner_revocation, offboarding.ownerRevocation.event);
  equal(offboard.disabled_event, offboarding.disabledEvent);
  assert.equal(offboard.gateway_ancestry, true);
  const privateReports = [
    ...requests,
    ...result.notification_traces,
    ...result.watch_traces,
    ...result.state_traces,
    ...result.authority_traces,
  ];
  const all = [...privateReports, ...result.traces, offboard];
  unique(all.map((report) => report.trace_id));
  const diagnostics = workspacePrivateTraceOutcome(privateReports);
  return {
    strict_exit: foundationTraceExitCode(all),
    accepted_exit:
      diagnostics.accepted && clockWarningsOnly([...result.traces, offboard])
        ? 0
        : 1,
    private_diagnostics: diagnostics,
    inventory: {
      connections: 5,
      initializations: 5,
      business_requests: 12,
      original_business_requests: 11,
      revocation_probes: 1,
      sessions: 2,
      login_sessions: 1,
      runs: 3,
      provider_requests: 5,
      runtime_tool_calls: 3,
      notifications: 1,
      deliberate_disconnects: 2,
      private_state_watches: 2,
      private_state_reads: states.length,
      identity_resolves: scopes.length,
      lifecycle_admissions: 4,
      offboarding_operations: 1,
    },
  };
}
