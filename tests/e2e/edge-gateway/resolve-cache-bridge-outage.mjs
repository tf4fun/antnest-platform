import assert from "node:assert/strict";
import { assertCancelledRun } from "../workspace-closeout/current-evidence.mjs";
import { groupAlive, processStat } from "../workspace-closeout/process.mjs";
import {
  cacheRuntimePhase,
  cacheRuntimeMarker,
  cacheRuntimeFiles,
} from "../workspace-closeout/cache-runtime-work.mjs";

const finite = (value) =>
  assert(Number.isFinite(value), "missing actual observation time");
const text = (value) => assert(typeof value === "string" && value.length > 0);
const one = (rows, label) => {
  assert.equal(rows.length, 1, label);
  return rows[0];
};
const interval = (row) => {
  finite(row.started_at);
  finite(row.at);
  assert(row.started_at <= row.at, "reversed observation interval");
};
const response = (row, path, method, status, { requireTrace = true } = {}) => {
  interval(row);
  assert.equal(row.path, path);
  assert.equal(row.method, method);
  assert.equal(row.status, status);
  assert.equal(row.set_cookie_count, 0, "outage request renewed authority");
  if (requireTrace) assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
};

export function bridgeRuntimeTurn(view, evidence) {
  if (
    view?.agentId !== evidence.agent_id ||
    view.selectedSessionId !== evidence.session_id ||
    view.selectedView?.agentId !== evidence.agent_id ||
    view.selectedView.sessionId !== evidence.session_id
  )
    return null;
  const turns = view.selectedView.turns.filter(
    (row) => row.turnId === evidence.run_id,
  );
  return turns.length === 1 ? turns[0] : null;
}

export function bridgeRuntimeTool(view, evidence) {
  const turn = bridgeRuntimeTurn(view, evidence);
  if (turn?.outcome !== "running") return null;
  const items = (turn.liveProcessDelta?.items ?? []).filter(
    ({ item }) =>
      item.id === evidence.runtime.tool_id &&
      item.kind === "tool" &&
      item.status === "running",
  );
  return items.length === 1 ? items[0].item : null;
}

// Input and final rawOutput can contain the command's marker without any live
// stdout. Only an actual progress detail of the bound running Tool can qualify.
export function hasBridgeRuntimeOutput(view, evidence) {
  const item = bridgeRuntimeTool(view, evidence);
  if (!item) return false;
  const sections = item.toolSections;
  if (
    !Number.isSafeInteger(sections?.detailStartIndex) ||
    sections.detailStartIndex < 0 ||
    sections.detailStartIndex > item.content.length
  )
    return false;
  for (const key of ["inputIndex", "outputIndex"])
    if (
      sections[key] !== undefined &&
      (!Number.isSafeInteger(sections[key]) ||
        sections[key] < 0 ||
        sections[key] >= sections.detailStartIndex)
    )
      return false;
  const stdout = item.content
    .slice(sections.detailStartIndex)
    .filter((part) => part.type === "text" && part.text.startsWith("stdout: "))
    // ToolProgress joins notifications with one separator newline, including
    // when one Runtime write was split across stdout notifications.
    .map((part) =>
      part.text.slice("stdout: ".length).split("\nstdout: ").join(""),
    )
    .join("");
  return stdout === `${cacheRuntimeMarker}\n`;
}

function inspectRuntimeObservation(row, expected, alive, effects) {
  interval(row);
  assert.deepEqual(
    row.container,
    expected.container,
    "Runtime identity/process changed",
  );
  assert.equal(row.status.status, "ready");
  assert.equal(row.status.execution_id, expected.runtime_execution_id);
  const work = row.work;
  for (const key of ["pid", "pgid"]) {
    assert(Number.isSafeInteger(work[key]) && work[key] > 1);
    assert.equal(
      work[key],
      expected.started.work[key],
      `different Runtime work ${key}`,
    );
  }
  assert.equal(
    work.effects,
    effects,
    "Runtime work completed or unexpected effects occurred",
  );
  assert.equal(
    groupAlive(work.processes, work.pgid),
    alive,
    "Runtime process group liveness differs",
  );
  if (alive) {
    const stat = processStat(work.stat);
    assert.equal(stat.pid, work.pid);
    assert.equal(stat.group, work.pgid);
    assert.notEqual(stat.state, "Z");
    const same = one(
      work.processes
        .split("\n")
        .filter((line) => line.trim() && processStat(line).pid === work.pid),
      "actual held bash missing from process inventory",
    );
    const sampled = processStat(same);
    assert.equal(sampled.pid, stat.pid);
    assert.equal(sampled.group, stat.group);
    assert.notEqual(sampled.state, "Z");
  }
}

// This gate proves the business window from actual observations. Independent
// authority, rejection and recovery checks remain mandatory; Trace is auxiliary.
export function inspectBridgeOutageWindow(
  evidence,
  { requireTrace = true } = {},
) {
  assert.equal(evidence.policy_revision, 4);
  assert.equal(evidence.transport, "http-sse");
  const {
    identity,
    runtime,
    stream,
    prompt,
    cancel,
    audit_before: before,
    audit,
  } = evidence;
  for (const key of [
    "project",
    "agent_id",
    "session_id",
    "intent_id",
    "run_id",
  ])
    text(evidence[key]);
  const principal = evidence.session_deadlines.owner.principal;
  text(principal.organization_id);
  text(principal.user_id);
  const start = identity.stopped.at,
    end = identity.restart_started_at;
  [
    identity.before.at,
    identity.stop_started_at,
    start,
    end,
    identity.stopped_end.at,
    identity.after.at,
  ].forEach(finite);
  assert(
    identity.before.at <= identity.stop_started_at &&
      identity.stop_started_at < start,
  );
  assert(end - start >= 5000, "Identity must remain stopped for five seconds");
  assert(
    identity.stopped_end.at >= start + 5000 && identity.stopped_end.at <= end,
  );
  assert(identity.after.at >= end);
  assert.match(identity.before.id, /^[a-f0-9]{64}$/u);
  for (const state of [
    identity.before,
    identity.stopped,
    identity.stopped_end,
    identity.after,
  ]) {
    assert.equal(state.id, identity.before.id, "Identity container replaced");
    assert.equal(state.project, evidence.project);
    assert.equal(state.service, "identity-service");
    assert.equal(state.restarting, false);
    assert.equal(state.oom_killed, false);
    assert.equal(state.exit_code, 0);
  }
  assert.equal(identity.before.running, true);
  assert.equal(identity.after.running, true);
  for (const stopped of [identity.stopped, identity.stopped_end]) {
    assert.equal(stopped.running, false);
    assert.equal(stopped.started_at, identity.before.started_at);
    assert.equal(stopped.finished_at, identity.stopped.finished_at);
  }
  const stoppedAt = Date.parse(identity.stopped.finished_at);
  finite(stoppedAt);
  assert(Date.parse(identity.before.started_at) < stoppedAt);
  assert(Date.parse(identity.after.started_at) > stoppedAt);
  const inside = (at) => {
    finite(at);
    assert(at >= start && at < end, "observation outside Identity outage");
  };
  const insideInterval = (row) => {
    interval(row);
    inside(row.started_at);
    inside(row.at);
  };
  const base = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}`;
  const session = `${base}/sessions/${encodeURIComponent(evidence.session_id)}`;
  response(prompt, `${session}/prompts`, "POST", 202, { requireTrace });
  assert(prompt.at < identity.stop_started_at);
  assert.deepEqual(prompt.body, {
    operationId: evidence.intent_id,
    acceptance: "bridge",
    phase: "dispatching",
  });
  assert.equal(prompt.request.intentId, evidence.intent_id);
  assert(
    Number.isSafeInteger(prompt.request.expectedAppendVersion) &&
      prompt.request.expectedAppendVersion >= 0,
  );
  assert.deepEqual(prompt.request.prompt, [
    { type: "text", text: cacheRuntimePhase },
  ]);
  assert.equal(
    stream.path,
    `${base}/events?sessionId=${encodeURIComponent(evidence.session_id)}`,
  );
  assert.equal(stream.status, 200);
  if (requireTrace) assert.match(stream.trace_id ?? "", /^[a-f0-9]{32}$/u);
  assert.equal(stream.set_cookie_count, 0);
  finite(stream.started_at);
  finite(stream.headers_at);
  assert(
    stream.started_at <= stream.headers_at &&
      stream.headers_at < identity.stop_started_at,
  );
  assert.equal(stream.credential_scope, prompt.credential_scope);
  text(stream.credential_scope);
  if (stream.closure)
    assert(stream.closure.at >= end, "stream closed inside outage");
  if (stream.revoked)
    assert(stream.revoked.at >= end, "stream revoked inside outage");
  assert(stream.records.length > 0);
  let previousAt = stream.headers_at;
  for (const record of stream.records) {
    finite(record.at);
    assert(record.at >= previousAt);
    previousAt = record.at;
  }
  const held = stream.records
    .filter(
      (row) =>
        row.at >= prompt.started_at &&
        row.at < identity.stop_started_at &&
        bridgeRuntimeTool(row.view, evidence),
    )
    .at(-1);
  assert(held, "actual accepted running Tool absent before stop");
  const accepted = one(
    held.view.operations.filter(
      (row) => row.operationId === evidence.intent_id,
    ),
    "actual accepted intent absent",
  );
  assert.equal(accepted.sessionId, evidence.session_id);
  assert.equal(accepted.acceptance, "acp");
  assert.equal(accepted.runId, evidence.run_id);
  assert(["accepted", "running"].includes(accepted.phase));
  const heldTurn = bridgeRuntimeTurn(held.view, evidence);
  text(runtime.runtime_revision);
  assert.equal(runtime.organization_id, principal.organization_id);
  text(runtime.runtime_execution_id);
  text(runtime.execution_revision);
  text(runtime.tool_id);
  assert.match(runtime.container.id, /^[a-f0-9]{64}$/u);
  assert.match(runtime.container.image, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(runtime.container.project, evidence.project);
  assert.equal(runtime.container.agent_id, evidence.agent_id);
  finite(Date.parse(runtime.container.started_at));
  assert(
    Number.isSafeInteger(runtime.container.restarts) &&
      runtime.container.restarts >= 0,
  );
  assert.equal(runtime.container.running, true);
  assert.equal(runtime.container.health, "healthy");
  inspectRuntimeObservation(runtime.started, runtime, true, "started\n");
  assert(runtime.started.at < identity.stop_started_at);
  insideInterval(runtime.emit);
  assert.equal(runtime.emit.container_id, runtime.container.id);
  assert.equal(runtime.emit.path, cacheRuntimeFiles.emit);
  for (const row of stream.records.filter(
    (row) => row.at < runtime.emit.started_at,
  ))
    assert(
      !hasBridgeRuntimeOutput(row.view, evidence),
      "stdout existed before emit gate",
    );
  const output = stream.records.find(
    (row) =>
      row.at >= runtime.emit.started_at &&
      row.at < cancel.started_at &&
      hasBridgeRuntimeOutput(row.view, evidence),
  );
  assert(output, "new real Runtime stdout not observed before cancellation");
  inside(output.at);
  assert(
    output.view.selectedView.outputWatermark >
      held.view.selectedView.outputWatermark,
  );
  assert(
    bridgeRuntimeTurn(output.view, evidence).processVersion >
      heldTurn.processVersion,
  );
  inspectRuntimeObservation(
    runtime.before_cancel,
    runtime,
    true,
    "started\nemitted\n",
  );
  insideInterval(runtime.before_cancel);
  assert(
    runtime.before_cancel.started_at >= output.at &&
      runtime.before_cancel.at <= cancel.started_at,
  );
  response(
    cancel,
    `${session}/operations/${encodeURIComponent(evidence.intent_id)}/cancel`,
    "POST",
    200,
    { requireTrace },
  );
  insideInterval(cancel);
  assert.equal(cancel.credential_scope, prompt.credential_scope);
  assert.deepEqual(cancel.request, { expectedRunId: evidence.run_id });
  assert.equal(cancel.body.operationId, evidence.intent_id);
  assert.equal(cancel.body.sessionId, evidence.session_id);
  assert.equal(cancel.body.acceptance, "acp");
  assert.equal(cancel.body.runId, evidence.run_id);
  assert(["cancelling", "uncertain"].includes(cancel.body.phase));
  if (cancel.body.phase === "uncertain")
    assert.equal(cancel.body.errorClass, "cancelled_tool_outcome_unknown");
  inspectRuntimeObservation(
    runtime.quiescent,
    runtime,
    false,
    "started\nemitted\n",
  );
  insideInterval(runtime.quiescent);
  assert(runtime.quiescent.started_at >= cancel.at);
  const auditPath = `/api/admin/execution-audits/${encodeURIComponent(evidence.run_id)}`;
  for (const row of [before, audit]) {
    response(row, auditPath, "GET", 200, { requireTrace });
    assert.equal(row.body.run_id, evidence.run_id);
    assert.equal(row.body.agent_id, evidence.agent_id);
    assert.equal(row.body.session_id, evidence.session_id);
    assert.equal(row.body.principal_id, principal.user_id);
    const snapshot = row.body.execution_snapshot;
    assert.equal(snapshot.executionRevision, runtime.execution_revision);
  }
  assert.equal(before.body.state, "running");
  assert(
    before.at < identity.stop_started_at &&
      before.started_at >= runtime.started.at,
  );
  insideInterval(audit);
  assert(audit.started_at >= cancel.at);
  assertCancelledRun(
    audit.body,
    evidence.agent_id,
    evidence.session_id,
    runtime.execution_revision,
  );
  assert.deepEqual(
    audit.body.execution_snapshot,
    before.body.execution_snapshot,
  );
  const storage = evidence.run_storage;
  assert.match(storage.container_id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(storage.project, evidence.project);
  assert.equal(storage.database, "antnest_agent_acp");
  const storedScope = {
    run_id: evidence.run_id,
    session_id: evidence.session_id,
    agent_id: evidence.agent_id,
    principal_id: principal.user_id,
    organization_id: principal.organization_id,
    bridge_intent_id: evidence.intent_id,
    snapshot_organization_id: principal.organization_id,
    execution_revision: runtime.execution_revision,
    runtime_revision: runtime.runtime_revision,
    runtime_execution_id: runtime.runtime_execution_id,
  };
  for (const [row, label, state] of [
    [storage.before, "before-stop", "running"],
    [storage.after, "after-cancel", "unresolved"],
  ]) {
    interval(row);
    assert.equal(row.label, label);
    assert.equal(row.record.state, state);
    for (const [key, value] of Object.entries(storedScope))
      assert.equal(row.record[key], value, `actual stored Run differs: ${key}`);
    assert.match(row.record.snapshot_sha256 ?? "", /^[a-f0-9]{64}$/u);
  }
  assert(storage.before.started_at >= before.at);
  assert(storage.before.at < identity.stop_started_at);
  insideInterval(storage.after);
  assert(storage.after.started_at >= audit.at);
  assert.equal(
    storage.after.record.snapshot_sha256,
    storage.before.record.snapshot_sha256,
    "accepted internal execution snapshot changed during cancellation",
  );
  const terminal = stream.records.find(
    (row) =>
      row.at >= cancel.started_at &&
      row.at < end &&
      bridgeRuntimeTurn(row.view, evidence)?.outcome === "unknown" &&
      row.view.availability === "offline" &&
      row.view.activeSessionId === null,
  );
  assert(
    terminal,
    "same Run unresolved terminal absent from the original SSE stream",
  );
  const terminalOperation = one(
    terminal.view.operations.filter(
      (row) => row.operationId === evidence.intent_id,
    ),
    "original terminal operation missing",
  );
  assert.equal(terminalOperation.sessionId, evidence.session_id);
  assert.equal(terminalOperation.runId, evidence.run_id);
  assert.equal(terminalOperation.acceptance, "acp");
  assert.equal(terminalOperation.phase, "uncertain");
  assert.equal(terminalOperation.errorClass, "cancelled_tool_outcome_unknown");
  const phaseRequests = (observation) => {
    finite(observation.at);
    assert.deepEqual(observation.state.errors, []);
    assert(
      !observation.state.pending.includes(cacheRuntimePhase),
      "model holds execution instead of Runtime",
    );
    const request = one(
      observation.state.requests.filter(
        (row) => row.phase === cacheRuntimePhase,
      ),
      "held Runtime model dispatch repeated/missing",
    );
    assert.equal(request.stage, "tool");
    finite(request.received_at_ms);
    if (requireTrace) {
      assert.match(request.trace_id, /^[a-f0-9]{32}$/u);
      assert.match(request.model_span_id, /^[a-f0-9]{16}$/u);
    }
    assert.equal(request.disconnected, undefined);
    assert.equal(request.released_at_ms, undefined);
    if (requireTrace) return request;
    const business = { ...request };
    for (const key of ["trace_id", "traceID", "model_span_id"])
      delete business[key];
    return business;
  };
  assert(evidence.model_started.at < identity.stop_started_at);
  inside(evidence.model_cancelled.at);
  assert(evidence.model_cancelled.at >= cancel.at);
  assert.deepEqual(
    phaseRequests(evidence.model_cancelled),
    phaseRequests(evidence.model_started),
  );
  return {
    policy_revision: 4,
    transport: "http-sse",
    run_id: evidence.run_id,
    stopped_ms: end - start,
    new_output_ms: output.at - start,
    terminal_ms: audit.at - start,
    runtime_quiescent_ms: runtime.quiescent.at - start,
    output_watermark: output.view.selectedView.outputWatermark,
    runtime_quiescent: true,
    runtime_execution_id: runtime.runtime_execution_id,
    scope:
      "business-window-only; independent authority/rejection/recovery checks remain",
  };
}
