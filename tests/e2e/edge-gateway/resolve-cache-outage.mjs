import assert from "node:assert/strict";
import { inspectBridgeOutageWindow } from "./resolve-cache-bridge-outage.mjs";
import { parseDeliveryMark } from "./resolve-cache-delivery.mjs";

export const outagePhase = "c4-cache-outage";
export const outageText = `${outagePhase}: fresh output before cancellation.`;
const traceID = (value) => assert.match(value ?? "", /^[a-f0-9]{32}$/u);
const finite = (value) =>
  assert(Number.isFinite(value), "actual monotonic observation missing");

// These verifiers retain keys only in process memory. A successful admission
// in a new process loads keys no earlier than process start. The restart call's
// start is an earlier, conservative bound; no unlabelled JWKS span is attributed.
export function inspectFreshConsumerWindow(
  evidence,
  { requireTrace = true } = {},
) {
  const bridge = evidence.policy_revision === 4;
  if (bridge) assert.equal(evidence.transport, "http-sse");
  assert.match(evidence.project ?? "", /^antnest-lifecycle-[a-f0-9]{8}$/u);
  assert.deepEqual(
    evidence.consumer_restarts.map((row) => row.service).sort(),
    ["agent-acp-service", "agent-ui"],
  );
  const { synchronization, state } = evidence.consumer_configuration;
  const acp = evidence.consumer_restarts.find(
    (row) => row.service === "agent-acp-service",
  );
  const restartedAt = bridge
    ? Math.max(...evidence.consumer_restarts.map((row) => row.after.at))
    : acp.after.at;
  finite(restartedAt);
  for (const row of [synchronization, state]) {
    assert.equal(row.status, 200);
    if (requireTrace) traceID(row.trace_id);
    finite(row.started_at);
    finite(row.at);
    assert(row.started_at > restartedAt && row.at >= row.started_at);
    assert(
      row.at < (bridge ? evidence.stream.started_at : evidence.wire.upgrade.at),
      "configuration must recover before admission",
    );
  }
  assert(state.started_at >= synchronization.at);
  assert.equal(
    evidence.session_deadlines.admin.principal.organization_id,
    evidence.session_deadlines.owner.principal.organization_id,
  );
  const applied = synchronization.body.synchronization;
  assert(
    applied && Number.isSafeInteger(applied.revision) && applied.revision > 0,
  );
  assert.equal(applied.applied_revision, applied.revision);
  assert(
    Date.parse(applied.applied_at) > Date.parse(acp.after.started_at),
    "configuration acknowledgement predates new ACP process",
  );
  assert.equal(state.body.availability, "ready");
  if (bridge) {
    const base = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}`;
    assert.equal(synchronization.method, "GET");
    assert.equal(synchronization.path, "/api/admin/execution-synchronization");
    assert.equal(state.method, "GET");
    assert.equal(state.path, `${base}/view`);
    assert.equal(state.body.agentId, evidence.agent_id);
    assert.equal(state.body.activeSessionId, null);
    assert.equal(
      evidence.stream.path,
      `${base}/events?sessionId=${encodeURIComponent(evidence.session_id)}`,
    );
    assert(
      typeof state.credential_scope === "string" &&
        state.credential_scope.length > 0,
    );
    assert.equal(evidence.stream.credential_scope, state.credential_scope);
    assert.equal(state.set_cookie_count, 0);
    assert.equal(evidence.stream.set_cookie_count, 0);
    finite(evidence.stream.started_at);
    finite(evidence.stream.headers_at);
    assert(evidence.stream.headers_at >= evidence.stream.started_at);
    finite(evidence.identity.stop_started_at);
  } else {
    assert.equal(state.body.agent_id, evidence.agent_id);
    assert.equal(state.body.access_allowed, true);
    assert.equal(state.body.active_session_id, null);
    assert.equal(state.body.unavailable_reason, null);
    assert.match(state.body.configuration_revision ?? "", /^[a-f0-9]{64}$/u);
  }
  const budgets = evidence.consumer_restarts.map((row) => {
    assert.equal(row.after.project, evidence.project);
    assert.equal(row.after.service, row.service);
    assert.equal(row.after.id, row.before.id);
    assert(
      Date.parse(row.after.started_at) > Date.parse(row.before.started_at),
      "consumer process did not restart",
    );
    assert.equal(row.after.running, true);
    assert.equal(row.after.health, "healthy");
    finite(row.started_at);
    finite(row.after.at);
    assert(row.after.at > row.started_at);
    if (bridge) {
      assert.equal(row.before.project, evidence.project);
      assert.equal(row.before.service, row.service);
      finite(row.before.at);
      assert(row.before.at <= row.started_at);
    }
    // The actual UI -> ACP admission chain is verified by the separate raw
    // authority gate. This HTTP response is only its conservative time bound.
    const admission =
      row.service === "agent-acp-service"
        ? bridge
          ? state
          : evidence.wire.upgrade
        : evidence.stream;
    assert.equal(
      admission.status,
      row.service === "agent-acp-service" && !bridge ? 101 : 200,
    );
    if (requireTrace) traceID(admission.trace_id);
    const at =
      row.service === "agent-acp-service" ? admission.at : admission.headers_at;
    finite(at);
    assert(
      at > row.after.at &&
        at <
          (bridge
            ? evidence.identity.stop_started_at
            : evidence.identity.stopped.at),
      "consumer admission must follow new process startup",
    );
    const deadline = row.started_at + 30000;
    assert(
      evidence.identity.restart_started_at < deadline,
      "new-process JWKS lower bound exhausted",
    );
    return {
      service: row.service,
      admission_at: at,
      conservative_deadline: deadline,
    };
  });
  return {
    conservative_deadline: Math.min(
      ...budgets.map((row) => row.conservative_deadline),
    ),
    consumers: budgets,
  };
}

export function outageOutput(view, agentID, sessionID, runID, sequence) {
  if (
    view.agentId !== agentID ||
    view.selectedSessionId !== sessionID ||
    view.selectedView?.agentId !== agentID ||
    view.selectedView?.sessionId !== sessionID ||
    !(view.selectedView.outputWatermark >= sequence)
  )
    return false;
  const turn = view.selectedView.turns.find((item) => item.turnId === runID);
  if (!turn) return false;
  const parts = [
    ...turn.finalResponse,
    ...(turn.liveProcessDelta?.items ?? [])
      .filter(
        ({ item }) =>
          item.kind === "notice" &&
          item.summary === "Intermediate response" &&
          item.status === "completed",
      )
      .flatMap(({ item }) => item.content),
  ];
  return parts.some((part) => part.type === "text" && part.text === outageText);
}

export function outageTerminal(view, agentID, sessionID, runID) {
  return (
    view.agentId === agentID &&
    view.selectedSessionId === sessionID &&
    view.selectedView?.agentId === agentID &&
    view.selectedView?.sessionId === sessionID &&
    view.selectedView.turns.some(
      (item) => item.turnId === runID && item.outcome === "cancelled",
    )
  );
}

export function outageDelivery(
  wire,
  sessionID,
  runID,
  after,
  before = Infinity,
) {
  const parts = [],
    previous = new Set();
  for (const frame of wire.frames) {
    if (frame.direction !== "receive" || frame.at >= before) continue;
    const message = JSON.parse(frame.raw),
      params = message.params;
    if (message.method !== "session/update" || params?.sessionId !== sessionID)
      continue;
    const mark = parseDeliveryMark(params._meta?.["antnest.dev/delivery"]);
    if (mark?.kind === "part" && mark.runId === runID) {
      if (frame.at < after) {
        previous.add(`${mark.sequence}:${mark.messageId}`);
        assert(
          !(
            params.update?.sessionUpdate === "agent_message_chunk" &&
            params.update.content?.type === "text" &&
            params.update.content.text === outageText
          ),
          "model output already existed before release",
        );
      } else parts.push({ frame, params, mark });
    }
  }
  const found = parts.find(
    ({ params }) =>
      params.update?.sessionUpdate === "agent_message_chunk" &&
      params.update.content?.type === "text" &&
      params.update.content.text === outageText,
  );
  if (!found) return null;
  assert(
    !previous.has(`${found.mark.sequence}:${found.mark.messageId}`),
    "output batch began before release",
  );
  const batch = parts.filter(
    ({ mark }) => mark.sequence === found.mark.sequence,
  );
  const indices = new Map();
  for (const part of batch) {
    assert.equal(
      part.mark.messageId,
      found.mark.messageId,
      "conflicting output batch identity",
    );
    assert.equal(
      part.mark.partCount,
      found.mark.partCount,
      "conflicting output batch size",
    );
    if (indices.has(part.mark.partIndex))
      assert.equal(
        indices.get(part.mark.partIndex),
        JSON.stringify(part.params.update),
      );
    indices.set(part.mark.partIndex, JSON.stringify(part.params.update));
  }
  if (indices.size !== found.mark.partCount) return null;
  return {
    at: Math.max(...batch.map(({ frame }) => frame.at)),
    sequence: found.mark.sequence,
  };
}

// Business-window evidence only. Authority budgets require independent checks;
// complete raw Trace diagnostics cannot be inferred from these observations.
export function inspectOutageWindow(evidence, { requireTrace = true } = {}) {
  if (evidence.policy_revision === 4)
    return inspectBridgeOutageWindow(evidence, { requireTrace });
  const {
    identity,
    wire,
    stream,
    release,
    audit,
    agent_id: agentID,
    session_id: sessionID,
    run_id: runID,
  } = evidence;
  for (const value of [agentID, sessionID, runID])
    assert(typeof value === "string" && value.length);
  const start = identity.stopped.at,
    end = identity.restart_started_at;
  for (const at of [
    start,
    end,
    identity.stopped_end.at,
    identity.after.at,
    release.started_at,
    release.at,
    evidence.cancel_at,
  ])
    finite(at);
  assert(end - start >= 5000, "Identity must stay stopped for five seconds");
  assert(
    identity.stopped_end.at >= start + 5000 && identity.stopped_end.at <= end,
  );
  for (const state of [identity.stopped, identity.stopped_end, identity.after])
    assert.equal(state.id, identity.before.id, "Identity container replaced");
  assert.equal(identity.before.running, true);
  assert.equal(identity.stopped.running, false);
  assert.equal(identity.stopped_end.running, false);
  assert.equal(identity.stopped.restarting, false);
  assert.equal(identity.stopped_end.restarting, false);
  assert.equal(identity.stopped.started_at, identity.before.started_at);
  assert.equal(
    identity.stopped_end.started_at,
    identity.stopped.started_at,
    "Identity restarted inside the stop window",
  );
  assert.equal(
    identity.stopped_end.finished_at,
    identity.stopped.finished_at,
    "Identity stopped again inside the window",
  );
  assert.equal(identity.after.running, true);
  assert(
    Number.isFinite(Date.parse(identity.stopped.finished_at)),
    "actual Docker stop timestamp missing",
  );
  assert(Number.isFinite(Date.parse(identity.after.started_at)));
  assert.notEqual(
    identity.before.started_at,
    identity.after.started_at,
    "Identity did not restart",
  );
  assert(identity.after.at >= end);
  const inside = (at) => {
    finite(at);
    assert(at >= start && at < end, "observation outside Identity stop");
  };
  assert.equal(wire.upgrade.status, 101);
  if (requireTrace) traceID(wire.upgrade.trace_id);
  assert(wire.upgrade.at < start);
  assert.equal(stream.status, 200);
  if (requireTrace) traceID(stream.trace_id);
  assert(stream.headers_at < start);
  if (stream.closure)
    assert(
      stream.closure.at >= end,
      "Workspace transport ended inside stop window",
    );
  assert(
    !stream.revoked || stream.revoked.at >= end,
    "Workspace access revoked inside stop window",
  );
  if (wire.closed_at !== undefined)
    assert(wire.closed_at >= end, "WSS transport ended inside stop window");
  inside(release.started_at);
  inside(release.at);
  assert.equal(release.status, 200);
  assert(release.at >= release.started_at);
  const delivered = outageDelivery(
    wire,
    sessionID,
    runID,
    release.started_at,
    end,
  );
  assert(delivered, "fresh complete same-Run WSS model output missing");
  const output = stream.records.find(
    (record) =>
      record.at >= release.started_at &&
      record.at < end &&
      outageOutput(record.view, agentID, sessionID, runID, delivered.sequence),
  );
  assert(output, "fresh same-Run Workspace output missing");
  const cancels = wire.frames.filter(
    (frame) =>
      frame.direction === "send" &&
      JSON.parse(frame.raw).method === "session/cancel",
  );
  assert.equal(cancels.length, 1, "one actual target cancel required");
  const cancel = cancels[0],
    message = JSON.parse(cancel.raw);
  inside(evidence.cancel_at);
  inside(cancel.at);
  assert(
    cancel.at >= evidence.cancel_at &&
      evidence.cancel_at > Math.max(delivered.at, output.at),
    "cancel preceded new output",
  );
  assert.equal(message.params.sessionId, sessionID);
  assert.deepEqual(message.params._meta, {
    "antnest.dev/target-cancel": { expectedRunId: runID },
  });
  const terminal = stream.records.find(
    (record) =>
      record.at >= cancel.at &&
      record.at < end &&
      outageTerminal(record.view, agentID, sessionID, runID),
  );
  assert(terminal, "same-Run Workspace cancelled terminal missing");
  const phaseRows = (observation) => {
    assert.deepEqual(observation.state.errors, [], "model fixture error");
    return observation.state.requests
      .filter((row) => row.phase === outagePhase)
      .map((row) => {
        finite(row.received_at_ms);
        if (requireTrace) return row;
        const business = { ...row };
        for (const key of ["trace_id", "traceID", "model_span_id"])
          delete business[key];
        return business;
      });
  };
  assert(evidence.model_started.at < start);
  const initial = phaseRows(evidence.model_started);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].stage, "tool");
  assert.equal(initial[0].released_at_ms, undefined);
  assert.equal(initial[0].disconnected, undefined);
  assert(evidence.model_started.state.pending.includes(outagePhase));
  inside(evidence.model_held.at);
  assert(evidence.model_held.at < cancel.at);
  const held = phaseRows(evidence.model_held);
  assert.equal(held.length, 2);
  assert.equal(held[0].stage, "tool");
  assert.equal(held[1].stage, "reply");
  finite(held[0].released_at_ms);
  assert.deepEqual(
    held[0],
    { ...initial[0], released_at_ms: held[0].released_at_ms },
    "first model identity changed after release",
  );
  finite(held[1].received_at_ms);
  assert(held[1].received_at_ms >= held[0].released_at_ms);
  assert.equal(held[0].disconnected, undefined);
  assert.equal(held[1].released_at_ms, undefined);
  assert.equal(held[1].disconnected, undefined);
  assert(evidence.model_held.state.pending.includes(outagePhase));
  inside(evidence.model_cancelled.at);
  assert(evidence.model_cancelled.at >= cancel.at);
  const final = phaseRows(evidence.model_cancelled);
  assert.equal(final.length, 2);
  assert.deepEqual(final[0], held[0]);
  assert.deepEqual(final[1], {
    ...held[1],
    disconnected: true,
    disconnected_at_ms: final[1].disconnected_at_ms,
  });
  finite(final[1].disconnected_at_ms);
  assert(final[1].disconnected_at_ms >= held[1].received_at_ms);
  assert(!evidence.model_cancelled.state.pending.includes(outagePhase));
  inside(audit.started_at);
  inside(audit.at);
  assert(audit.started_at >= cancel.at && audit.at >= audit.started_at);
  assert.equal(audit.status, 200);
  assert.equal(audit.set_cookie_count, 0);
  if (requireTrace) traceID(audit.trace_id);
  for (const [name, value] of Object.entries({
    run_id: runID,
    agent_id: agentID,
    session_id: sessionID,
    state: "cancelled",
    terminal_class: "cancelled",
    executor_state: "quiescent",
    tool_effect_state: "settled",
  }))
    assert.equal(audit.body[name], value, `cancelled audit ${name}`);
  return {
    run_id: runID,
    stopped_ms: end - start,
    output_watermark: delivered.sequence,
    new_output_ms: Math.max(delivered.at, output.at) - start,
    terminal_ms:
      Math.max(terminal.at, audit.at, evidence.model_cancelled.at) - start,
  };
}
