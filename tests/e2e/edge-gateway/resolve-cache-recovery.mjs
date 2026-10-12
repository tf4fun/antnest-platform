import assert from "node:assert/strict";
import { observedHeldRun } from "../workspace-closeout/browser-control.mjs";

export const recoveryCases = [
  { name: "logout", phase: "c4-browser-hold-logout" },
  { name: "password", phase: "c4-browser-hold-peer" },
  { name: "role", phase: "c4-browser-hold-close" },
  { name: "deactivate", phase: "c4-browser-hold-cancel" },
];
const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const finite = (n) => assert(Number.isFinite(n), "observation time missing");

export function recoveryMembershipUpdate(entry, active) {
  const { membership } = entry;
  assert.equal(membership.user_id, entry.user.id);
  assert(membership.id && membership.email && membership.display_name);
  assert.equal(typeof active, "boolean");
  return {
    email: membership.email,
    display_name: membership.display_name,
    role: "admin",
    active,
  };
}

// These are actual HTTP, socket and model observations, not callbacks reporting
// a verdict. The separate Trace gate proves the original authority budget and
// binds each accepted Run to its single Provider request and durable closure.
export function inspectRecoveryWindow(evidence) {
  const cases = evidence.recovery?.cases;
  assert.deepEqual(
    cases?.map(({ name, phase }) => ({ name, phase })),
    recoveryCases,
  );
  assert.equal(evidence.identity.healthy.running, true);
  assert.equal(evidence.identity.healthy.health, "healthy");
  for (const key of ["session_id", "run_id", "intent_id"])
    assert.equal(
      new Set(cases.map((c) => c[key])).size,
      cases.length,
      `reused ${key}`,
    );
  const scopes = new Set();
  let previous = evidence.identity.healthy.at;
  const reports = cases.map((c) => {
    const base = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}`;
    const sessionPath = `${base}/sessions/${encodeURIComponent(c.session_id)}`;
    const response = (row, path, method, status, cookies = 0) => {
      assert(row, "actual recovery response missing");
      assert.deepEqual(
        one(
          evidence.http.filter((r) => r.trace_id === row.trace_id),
          "actual response missing or duplicate",
        ),
        row,
      );
      assert.match(row.trace_id, /^[a-f0-9]{32}$/u);
      assert.equal(row.path, path);
      assert.equal(row.method, method);
      assert.equal(row.status, status);
      assert.equal(row.set_cookie_count, cookies);
      [row.started_at, row.at].forEach(finite);
      assert(row.started_at <= row.at);
      return row;
    };
    const login = (row, role) => {
      response(row, "/api/session/login", "POST", 200, 2);
      assert.equal(row.body.principal.active, true);
      assert.equal(row.body.principal.organization_role, role);
      assert(
        row.issued_credential_scope && !scopes.has(row.issued_credential_scope),
        "fresh credential reused",
      );
      scopes.add(row.issued_credential_scope);
      return row.issued_credential_scope;
    };
    const role = c.name === "deactivate" ? "admin" : "member";
    const scope = login(c.login, role),
      peerScope = login(c.peer_login, role);
    const principal = c.login.body.principal;
    for (const key of ["user_id", "membership_id", "organization_id"])
      assert.equal(c.peer_login.body.principal[key], principal[key]);
    assert(c.login.started_at > previous);
    for (const [start, end] of [
      [c.wire.started_at, c.wire.upgrade.at],
      [c.stream.started_at, c.stream.headers_at],
    ]) {
      [start, end].forEach(finite);
      assert(c.login.at <= start && start <= end && end < c.trigger.at);
    }
    assert.equal(c.wire.upgrade.status, 101);
    assert.equal(c.wire.credential_scope, scope);
    assert.equal(c.stream.credential_scope, scope);
    assert.equal(c.stream.status, 200);
    assert.equal(c.stream.set_cookie_count, 0);
    assert.equal(
      c.stream.path,
      `${base}/events?sessionId=${encodeURIComponent(c.session_id)}`,
    );
    response(c.prompt, `${sessionPath}/prompts`, "POST", 202);
    assert.equal(c.prompt.credential_scope, scope);
    assert.equal(c.prompt.body.acceptance, "bridge");
    assert(c.prompt.at < c.trigger.at);
    const held = c.stream.records
      .filter((r) => r.at >= c.prompt.started_at && r.at < c.trigger.at)
      .find((r) =>
        r.view.operations?.some(
          (op) => op.operationId === c.intent_id && op.runId === c.run_id,
        ),
      );
    assert(held, "same accepted Run not observed before mutation");
    assert.equal(
      observedHeldRun(held.view, evidence.agent_id, c.session_id).runId,
      c.run_id,
    );
    const audit = (r, state) => {
      response(
        r,
        `/api/admin/execution-audits/${encodeURIComponent(c.run_id)}`,
        "GET",
        200,
      );
      for (const [key, value] of Object.entries({
        run_id: c.run_id,
        agent_id: evidence.agent_id,
        session_id: c.session_id,
        principal_id: principal.user_id,
        state,
      }))
        assert.equal(r.body[key], value, `wrong actual audit ${key}`);
      for (const key of ["created_at", "input", "execution_snapshot"]) {
        assert(
          r.body[key] !== undefined && r.body[key] !== null,
          `missing original Run ${key}`,
        );
        assert.deepEqual(
          r.body[key],
          c.audit_before.body[key],
          `changed original Run ${key}`,
        );
      }
      if (state === "running")
        for (const key of [
          "terminal_class",
          "executor_state",
          "tool_effect_state",
          "stop_reason",
          "error_class",
        ])
          assert.equal(r.body[key], null, `already settled running Run ${key}`);
      if (state !== "running") {
        assert.equal(r.body.terminal_class, state);
        assert.equal(r.body.executor_state, "quiescent");
        assert.equal(r.body.tool_effect_state, "none");
      }
      if (state === "completed") {
        assert.equal(r.body.stop_reason, "end_turn");
        assert.equal(r.body.error_class, null);
      }
      if (state === "cancelled") {
        assert.equal(r.body.stop_reason, null);
        assert.equal(r.body.error_class, null);
      }
    };
    const model = (r, mode) => {
      assert(
        r &&
          evidence.model_observations.some(
            (o) => JSON.stringify(o) === JSON.stringify(r),
          ),
        "actual model observation missing",
      );
      finite(r.at);
      assert.deepEqual(r.state.errors, []);
      const request = one(
        r.state.requests.filter((p) => p.phase === c.phase),
        "single actual held model required",
      );
      assert.equal(request.stage, "reply");
      assert.equal(request.trace_id, c.prompt.trace_id);
      assert.match(request.model_span_id ?? "", /^[a-f0-9]{16}$/u);
      finite(request.received_at_ms);
      if (mode === "held") {
        assert(r.state.pending.includes(c.phase));
        assert.equal(request.released_at_ms, undefined);
        assert.notEqual(request.disconnected, true);
      } else {
        assert(!r.state.pending.includes(c.phase));
        if (mode === "cancelled") {
          assert.equal(request.disconnected, true);
          finite(request.disconnected_at_ms);
          assert.equal(request.released_at_ms, undefined);
        } else {
          assert.notEqual(request.disconnected, true);
          finite(request.released_at_ms);
        }
      }
      return request;
    };
    model(c.model_started, "held");
    audit(c.audit_before, "running");
    assert(
      c.model_started.at < c.trigger.at && c.audit_before.at < c.trigger.at,
    );
    const mutationPath = `/api/admin/directory/memberships/${encodeURIComponent(principal.membership_id)}`;
    response(
      c.mutation,
      c.name === "logout"
        ? "/api/session"
        : c.name === "password"
          ? "/api/session/password"
          : mutationPath,
      c.name === "logout" ? "DELETE" : "POST",
      c.name === "logout" ? 204 : 200,
      ["logout", "password"].includes(c.name) ? 2 : 0,
    );
    assert(c.trigger.at <= c.mutation.started_at);
    if (["logout", "password"].includes(c.name))
      assert.equal(c.mutation.credential_scope, scope);
    else {
      assert.notEqual(
        c.mutation.credential_scope,
        scope,
        "directory mutation must use independent admin",
      );
      const m = c.mutation.body.membership;
      assert.equal(m.id, principal.membership_id);
      assert.equal(m.user_id, principal.user_id);
      assert.equal(m.role, "admin");
      assert.equal(m.active, c.name !== "deactivate");
    }
    if (c.name === "password") {
      assert(
        c.mutation.issued_credential_scope &&
          !scopes.has(c.mutation.issued_credential_scope),
        "password did not rotate credential",
      );
      scopes.add(c.mutation.issued_credential_scope);
      assert.deepEqual(c.mutation.body.principal, principal);
      assert.equal(c.mutation.body.expires_at, c.login.body.expires_at);
      assert(Number.isFinite(Date.parse(c.mutation.body.idle_expires_at)));
      assert(c.mutation.body.activity_interval_ms > 0);
    }
    assert.equal(c.wss_close.localClose, false);
    assert.equal(c.wss_close.code, 1008);
    assert.equal(c.wss_close.reason, "session_rejected");
    assert(
      c.wss_close.at >= c.trigger.observed_at_ms &&
        c.wss_close.at <= c.trigger.observed_at_ms + 30000,
    );
    assert(
      ["remote-end", "transport-end"].includes(c.stream.closure?.kind),
      "actual remote SSE retirement missing",
    );
    for (const at of [c.wss_close.observed_at, c.stream.closure.at]) {
      finite(at);
      assert(
        at >= c.trigger.at && at <= c.trigger.at + 30000,
        "remote retirement outside mutation bound",
      );
    }
    const closed = Math.max(c.wss_close.observed_at, c.stream.closure.at);
    const sent = c.wire.frames.filter((f) => f.direction === "send");
    assert.deepEqual(
      sent.map((f) => f.raw),
      c.quiet_requests,
      "silent observer sent a new request",
    );
    assert(sent.every((f) => f.at < c.trigger.at));
    const rejected = (r, expectedScope = scope) => {
      response(r, "/api/session", "GET", 401);
      assert.equal(r.credential_scope, expectedScope);
      assert(r.started_at >= c.mutation.at);
    };
    rejected(c.old_session);
    response(
      c.peer_session,
      "/api/session",
      "GET",
      c.name === "logout" ? 200 : 401,
    );
    assert.equal(c.peer_session.credential_scope, peerScope);
    assert(c.peer_session.started_at >= c.mutation.at);
    if (c.name === "password")
      response(c.old_password, "/api/session/login", "POST", 401);
    const terminal = c.name === "deactivate" ? "cancelled" : "completed";
    audit(c.audit_terminal, terminal);
    assert(c.audit_terminal.at > c.mutation.at);
    const finalModel = model(c.model_terminal, terminal);
    assert.equal(
      finalModel.model_span_id,
      model(c.model_started, "held").model_span_id,
    );
    assert.equal(
      finalModel.received_at_ms,
      model(c.model_started, "held").received_at_ms,
    );
    if (c.name === "deactivate") {
      assert.equal(
        c.release,
        undefined,
        "deactivation must cancel, not release model",
      );
      response(c.deactivated_login, "/api/session/login", "POST", 401);
      response(
        c.disabled_agent,
        `/api/admin/agents/${encodeURIComponent(evidence.agent_id)}`,
        "GET",
        200,
      );
      for (const [key, value] of Object.entries({
        agent_id: evidence.agent_id,
        owner_user_id: principal.user_id,
        desired_state: "disabled",
        lifecycle_state: "created",
        activation_state: "disabled",
        runtime_state: "absent",
      }))
        assert.equal(c.disabled_agent.body[key], value);
      response(c.restore, mutationPath, "POST", 200);
      assert.equal(c.restore.body.membership.id, principal.membership_id);
      assert.equal(c.restore.body.membership.active, true);
      assert(
        c.restore.started_at > c.disabled_agent.at &&
          c.restore.started_at > c.audit_terminal.at,
      );
      const fresh = login(c.fresh_login, "admin");
      assert(c.fresh_login.started_at > c.restore.at);
      response(
        c.restored_state,
        `/api/app/agents/${encodeURIComponent(evidence.agent_id)}/state`,
        "GET",
        200,
      );
      assert.equal(c.restored_state.credential_scope, fresh);
      assert.equal(c.restored_state.body.agent_id, evidence.agent_id);
      assert.equal(c.restored_state.body.availability, "offline");
      assert.equal(c.restored_state.body.access_allowed, false);
      assert.equal(c.restored_state.body.active_session_id, null);
      assert.equal(c.restored_state.body.configuration_revision, null);
      assert.equal(c.restored_state.body.unavailable_reason, "access_denied");
      rejected(c.restored_old_session);
      assert(c.restored_old_session.started_at > c.restore.at);
    } else {
      const afterClose = model(c.model_after_close, "held");
      const original = model(c.model_started, "held");
      assert.equal(afterClose.model_span_id, original.model_span_id);
      assert.equal(afterClose.received_at_ms, original.received_at_ms);
      audit(c.audit_after_close, "running");
      assert(
        c.model_after_close.at > closed &&
          c.audit_after_close.started_at > closed,
      );
      const fresh = login(
        c.fresh_login,
        c.name === "role" ? "admin" : "member",
      );
      assert(c.fresh_login.started_at > c.mutation.at);
      assert.equal(c.release.status, 200);
      assert(
        c.release.started_at > closed &&
          c.release.started_at > c.audit_after_close.at,
      );
      assert(
        c.model_terminal.at > c.release.at &&
          c.audit_terminal.at > c.release.at,
      );
      response(c.fresh_view, `${sessionPath}/view`, "GET", 200);
      assert.equal(c.fresh_view.credential_scope, fresh);
      assert.equal(c.fresh_view.body.agentId, evidence.agent_id);
      assert.equal(c.fresh_view.body.sessionId, c.session_id);
      const turn = one(
        c.fresh_view.body.turns.filter((t) => t.turnId === c.run_id),
        "fresh view same Run missing",
      );
      assert.equal(turn.outcome, "completed");
      assert(
        turn.finalResponse.some(
          (p) => p.type === "text" && p.text === `${c.phase} completed`,
        ),
      );
      assert(c.fresh_view.started_at > c.release.at);
    }
    for (const key of ["user_id", "membership_id", "organization_id"])
      assert.equal(c.fresh_login.body.principal[key], principal[key]);
    previous = Math.max(
      c.audit_terminal.at,
      c.fresh_view?.at ?? c.restored_old_session.at,
    );
    return {
      name: c.name,
      run_id: c.run_id,
      terminal,
      wss_close_ms: c.wss_close.observed_at - c.trigger.at,
      sse_close_ms: c.stream.closure.at - c.trigger.at,
    };
  });
  return { status: "passed", cases: reports };
}
