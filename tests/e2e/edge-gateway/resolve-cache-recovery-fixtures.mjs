import { recoveryCases } from "./resolve-cache-recovery.mjs";

export function recoveryFixture() {
  let sequence = 0;
  const e = {
    agent_id: "agent",
    identity: { healthy: { running: true, health: "healthy", at: 10 } },
    http: [],
    model_observations: [],
    recovery: { cases: [] },
  };
  const principal = {
    user_id: "user",
    membership_id: "membership",
    organization_id: "org",
    organization_role: "member",
    active: true,
  };
  const http = (path, at, body, extra = {}) => {
    const row = {
      trace_id: (++sequence).toString(16).padStart(32, "0"),
      path,
      method: "GET",
      started_at: at - 1,
      at,
      status: 200,
      set_cookie_count: 0,
      body,
      ...extra,
    };
    e.http.push(row);
    return row;
  };
  for (const [index, { name, phase }] of recoveryCases.entries()) {
    const start = 100 + index * 1000,
      scope = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const peerScope = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const p = {
      ...principal,
      organization_role: index === 3 ? "admin" : "member",
    };
    const c = {
      name,
      phase,
      session_id: `session-${index}`,
      run_id: `run-${index}`,
      intent_id: `intent-${index}`,
    };
    const login = (at, issued, role = p.organization_role) =>
      http(
        "/api/session/login",
        at,
        {
          principal: { ...p, organization_role: role },
          expires_at: "2026-10-13T00:00:00Z",
          idle_expires_at: "2026-10-12T23:00:00Z",
          activity_interval_ms: 30000,
        },
        {
          method: "POST",
          set_cookie_count: 2,
          issued_credential_scope: issued,
        },
      );
    c.login = login(start, scope);
    c.peer_login = login(start + 1, peerScope);
    c.wire = {
      started_at: start + 2,
      credential_scope: scope,
      upgrade: {
        at: start + 3,
        status: 101,
        trace_id: (++sequence).toString(16).padStart(32, "0"),
      },
      frames: [
        {
          at: start + 4,
          direction: "send",
          raw: '{"id":1,"method":"initialize"}',
        },
      ],
    };
    c.stream = {
      status: 200,
      set_cookie_count: 0,
      credential_scope: scope,
      path: `/api/app/workspace/v1/agents/agent/events?sessionId=${c.session_id}`,
      started_at: start + 5,
      headers_at: start + 6,
      trace_id: (++sequence).toString(16).padStart(32, "0"),
      records: [
        {
          at: start + 12,
          view: {
            agentId: "agent",
            activeSessionId: c.session_id,
            selectedSessionId: c.session_id,
            selectedView: { agentId: "agent", sessionId: c.session_id },
            availability: "busy",
            operations: [
              {
                operationId: c.intent_id,
                acceptance: "acp",
                phase: "running",
                runId: c.run_id,
                sessionId: c.session_id,
              },
            ],
          },
        },
      ],
      closure: { kind: "remote-end", at: start + 40 },
    };
    c.prompt = http(
      `/api/app/workspace/v1/agents/agent/sessions/${c.session_id}/prompts`,
      start + 10,
      { acceptance: "bridge", operationId: c.intent_id },
      { method: "POST", status: 202, credential_scope: scope },
    );
    const model = (at, terminal = false) => {
      const observation = {
        at,
        state: {
          errors: [],
          pending: terminal ? [] : [phase],
          requests: [
            {
              phase,
              stage: "reply",
              trace_id: c.prompt.trace_id,
              model_span_id: "1111111111111111",
              received_at_ms: start + 11,
              ...(terminal
                ? name === "deactivate"
                  ? { disconnected: true, disconnected_at_ms: start + 45 }
                  : { released_at_ms: start + 60 }
                : {}),
            },
          ],
        },
      };
      e.model_observations.push(observation);
      return observation;
    };
    const audit = (at, state) =>
      http(`/api/admin/execution-audits/${c.run_id}`, at, {
        run_id: c.run_id,
        agent_id: "agent",
        session_id: c.session_id,
        principal_id: "user",
        state,
        created_at: "2026-10-12T12:00:00Z",
        input: [{ type: "text", text: phase }],
        execution_snapshot: { version: 1 },
        terminal_class: state === "running" ? null : state,
        executor_state: state === "running" ? null : "quiescent",
        tool_effect_state: state === "running" ? null : "none",
        stop_reason: state === "completed" ? "end_turn" : null,
        error_class: null,
      });
    c.model_started = model(start + 13);
    c.audit_before = audit(start + 14, "running");
    c.trigger = { at: start + 20, observed_at_ms: start + 20 };
    c.quiet_requests = c.wire.frames.map((f) => f.raw);
    c.mutation = http(
      name === "logout"
        ? "/api/session"
        : name === "password"
          ? "/api/session/password"
          : "/api/admin/directory/memberships/membership",
      start + 22,
      name === "logout"
        ? null
        : name === "password"
          ? c.login.body
          : {
              membership: {
                id: "membership",
                user_id: "user",
                role: "admin",
                active: name !== "deactivate",
              },
            },
      {
        method: name === "logout" ? "DELETE" : "POST",
        status: name === "logout" ? 204 : 200,
        set_cookie_count: ["logout", "password"].includes(name) ? 2 : 0,
        credential_scope: ["logout", "password"].includes(name)
          ? scope
          : "admin-scope",
      },
    );
    if (name === "password")
      c.mutation.issued_credential_scope = "rotated-password-scope";
    c.wss_close = {
      code: 1008,
      reason: "session_rejected",
      at: start + 35,
      observed_at: start + 35,
      localClose: false,
    };
    c.old_session = http(
      "/api/session",
      start + 42,
      { code: "unauthenticated" },
      { status: 401, credential_scope: scope },
    );
    c.peer_session = http(
      "/api/session",
      start + 43,
      name === "logout" ? c.login.body : { code: "unauthenticated" },
      { status: name === "logout" ? 200 : 401, credential_scope: peerScope },
    );
    if (name === "password")
      c.old_password = http(
        "/api/session/login",
        start + 44,
        { code: "invalid_credentials" },
        { method: "POST", status: 401 },
      );
    if (name === "deactivate") {
      c.deactivated_login = http(
        "/api/session/login",
        start + 44,
        { code: "invalid_credentials" },
        { method: "POST", status: 401 },
      );
      c.model_terminal = model(start + 46, true);
      c.audit_terminal = audit(start + 50, "cancelled");
      c.disabled_agent = http("/api/admin/agents/agent", start + 55, {
        agent_id: "agent",
        owner_user_id: "user",
        desired_state: "disabled",
        lifecycle_state: "created",
        activation_state: "disabled",
        runtime_state: "absent",
      });
      c.restore = http(
        "/api/admin/directory/memberships/membership",
        start + 57,
        {
          membership: {
            id: "membership",
            user_id: "user",
            role: "admin",
            active: true,
          },
        },
        { method: "POST" },
      );
      c.fresh_login = login(start + 58.5, `fresh-${index}`, "admin");
      c.restored_state = http(
        "/api/app/agents/agent/state",
        start + 60,
        {
          agent_id: "agent",
          availability: "offline",
          access_allowed: false,
          active_session_id: null,
          configuration_revision: null,
          unavailable_reason: "access_denied",
        },
        { credential_scope: `fresh-${index}` },
      );
      c.restored_old_session = http(
        "/api/session",
        start + 61,
        { code: "unauthenticated" },
        { status: 401, credential_scope: scope },
      );
    } else {
      c.model_after_close = model(start + 46);
      c.audit_after_close = audit(start + 47, "running");
      c.fresh_login = login(
        start + 48,
        `fresh-${index}`,
        name === "role" ? "admin" : "member",
      );
      c.release = { started_at: start + 59, at: start + 61, status: 200 };
      c.model_terminal = model(start + 65, true);
      c.audit_terminal = audit(start + 70, "completed");
      c.fresh_view = http(
        `/api/app/workspace/v1/agents/agent/sessions/${c.session_id}/view`,
        start + 75,
        {
          agentId: "agent",
          sessionId: c.session_id,
          turns: [
            {
              turnId: c.run_id,
              outcome: "completed",
              finalResponse: [{ type: "text", text: `${phase} completed` }],
            },
          ],
        },
        { credential_scope: `fresh-${index}` },
      );
    }
    e.recovery.cases.push(c);
  }
  return e;
}
