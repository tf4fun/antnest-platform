// Hand-authored resource observations; no Span or collector evidence is needed.
export function outageResourcesFixture() {
  const epoch = Date.parse("2026-10-14T00:00:00Z");
  const iso = (at) => new Date(epoch + at).toISOString();
  const e = {
    project: "project",
    agent_id: "agent",
    session_id: "session",
    run_id: "run",
    http: [],
  };
  const principal = {
    user_id: "owner",
    membership_id: "membership",
    organization_id: "org",
    organization_role: "member",
    active: true,
  };
  e.session_deadlines = { owner: { principal: structuredClone(principal) } };
  const state = (service, at, running = true, start = 0, finish = 200) => ({
    id: service + "-container",
    project: e.project,
    service,
    at,
    observed_at_ms: epoch + at,
    running,
    health: "healthy",
    restarting: false,
    oom_killed: false,
    exit_code: 0,
    started_at: iso(start),
    finished_at: iso(finish),
  });
  e.consumer_restarts = ["agent-acp-service", "agent-ui"].map((service) => ({
    service,
    started_at: 100,
    before: state(service, 80),
    after: state(service, 400, true, 300),
  }));
  e.identity = {
    before: state("identity-service", 500),
    stop_started_at: 900,
    stop_started_at_ms: epoch + 900,
    stopped: state("identity-service", 1000, false, 0, 950),
    stopped_end: state("identity-service", 6000, false, 0, 950),
    restart_started_at: 6001,
    restart_started_at_ms: epoch + 6001,
    after: state("identity-service", 6100, true, 6050, 950),
    healthy: state("identity-service", 6200, true, 6050, 950),
  };
  e.ui_drain = {
    log_checked: true,
    forced_drain: false,
    log_sha256: "a".repeat(64),
    started_at: 9010,
    before: state("agent-ui", 9000, true, 300),
    after: state("agent-ui", 9020, false, 300, 9015),
  };
  const http = (
    label,
    path,
    at,
    scope,
    body = {},
    status = 200,
    method = "GET",
  ) => {
    if (
      method === "GET" &&
      status === 200 &&
      path.startsWith("/api/app/workspace/") &&
      path.endsWith("/view")
    )
      body = {
        ...body,
        agentId: e.agent_id,
        ...(path.includes("/sessions/") ? { sessionId: e.session_id } : {}),
        bridgeEpoch: at < 100 ? "before-restart" : "after-restart",
      };
    const row = {
      label,
      path,
      method,
      started_at: at - 1,
      at,
      observed_at_ms: epoch + at,
      credential_scope: scope,
      set_cookie_count: 0,
      body,
      status,
      cache_control: "no-store",
    };
    e.http.push(row);
    return row;
  };
  const login = (label, at, scope) => {
    const row = http(
      label,
      "/api/session/login",
      at,
      null,
      { principal: structuredClone(principal) },
      200,
      "POST",
    );
    row.issued_credential_scope = scope;
    row.set_cookie_count = 2;
    return row;
  };
  login("prep-login", 30, "prep");
  login("warm-login", 420, "warm");
  login("audit-login", 40, "admin");
  const view = "/api/app/workspace/v1/agents/agent/sessions/session/view";
  http("prep-view", view, 70, "prep");
  http("warm-workspace-view", view, 800, "warm");
  http("recovered-workspace-view", view, 6300, "warm");
  http("warm-console-audit", "/api/admin/execution-audits/run", 810, "admin");
  e.consumer_configuration = {
    synchronization: http(
      "fresh-configuration-acknowledgement",
      "/api/admin/execution-synchronization",
      430,
      "admin",
    ),
    state: http(
      "fresh-configuration-state",
      "/api/app/workspace/v1/agents/agent/view",
      440,
      "warm",
    ),
  };
  e.prompt = http(
    "outage-prompt",
    "/api/app/workspace/v1/agents/agent/sessions/session/prompts",
    470,
    "warm",
    {},
    202,
    "POST",
  );
  e.cancel = http(
    "outage-cancel",
    "/api/app/workspace/v1/agents/agent/sessions/session/operations/intent/cancel",
    1500,
    "warm",
    {},
    200,
    "POST",
  );
  e.audit_before = http(
    "before-audit",
    "/api/admin/execution-audits/run",
    850,
    "admin",
  );
  e.audit = http(
    "after-audit",
    "/api/admin/execution-audits/run",
    1700,
    "admin",
  );
  e.runtime = { container: { generation: 1 } };
  for (const key of ["started", "before_cancel", "quiescent"])
    e.runtime[key] = { status: { generation: 1, agent_id: e.agent_id } };
  const stream = (session, scope, start, trigger) => ({
    path: `/api/app/workspace/v1/agents/agent/events?sessionId=${session}`,
    credential_scope: scope,
    status: 200,
    set_cookie_count: 0,
    started_at: start,
    headers_at: start + 1,
    closure: {
      kind: "remote-end",
      at: trigger + 20,
      observed_at_ms: epoch + trigger + 20,
    },
    joined: { at: trigger + 30, observed_at_ms: epoch + trigger + 30 },
  });
  e.recovery = {
    cases: ["logout", "password", "role", "deactivate"].map((name, index) => {
      const at = 6500 + index * 500,
        scope = name + "-scope";
      const c = {
        name,
        agent_id: e.agent_id,
        owner_id: principal.user_id,
        session_id: name + "-session",
        trigger: { at, observed_at_ms: epoch + at },
      };
      c.login = login(name + "-login", at - 120, scope);
      c.stream = stream(c.session_id, scope, at - 100, at);
      const mutationPath =
        name === "logout"
          ? "/api/session"
          : name === "password"
            ? "/api/session/password"
            : "/api/admin/directory/memberships/membership";
      c.mutation = http(
        name + "-mutation",
        mutationPath,
        at + 5,
        index < 2 ? scope : "admin",
        {},
        name === "logout" ? 204 : 200,
        name === "logout" ? "DELETE" : "POST",
      );
      c.old_session = http(
        name + "-old-session",
        "/api/session",
        at + 40,
        scope,
        { code: "unauthenticated", message: "revoked" },
        401,
      );
      if (name === "deactivate")
        c.restore = http(
          "restore",
          mutationPath,
          at + 60,
          "admin",
          { membership: { user_id: "owner", role: "admin" } },
          200,
          "POST",
        );
      return c;
    }),
  };
  e.stream = stream(e.session_id, "warm", 450, e.recovery.cases[1].trigger.at);
  return e;
}
