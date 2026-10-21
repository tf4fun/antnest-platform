import assert from "node:assert/strict";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const scopeID = (value) =>
  assert.match(
    value ?? "",
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );

// Match Gateway caller selection, including decoded Agent IDs and bootstrap's
// empty Agent key. Only the original request path determines its cache key.
function historyKey(path) {
  const pathname = decodeURIComponent(
    new URL(path, "http://evidence.invalid").pathname,
  );
  if (pathname === "/api/session" || pathname.startsWith("/api/session/"))
    return { profile: "session", agent: "" };
  if (pathname.startsWith("/api/admin/"))
    return { profile: "console", agent: "" };
  const base = "/api/app/workspace/v1/";
  assert(pathname.startsWith(base), "unknown protected cache-key history path");
  const relative = pathname.slice(base.length);
  if (relative === "bootstrap") return { profile: "workspace", agent: "" };
  const parts = relative.split("/");
  assert(
    parts.length >= 3 &&
      parts[0] === "agents" &&
      parts[1].length > 0 &&
      parts[1].length <= 200 &&
      !/[\\\0\r\n]/u.test(parts[1]),
    "workspace cache-key history lacks the actual Agent path",
  );
  return { profile: "workspace", agent: parts[1] };
}

export function inspectOutageRejectionBusiness(evidence) {
  assert.equal(
    evidence.policy_revision,
    4,
    "unsupported outage evidence revision",
  );
  assert.equal(evidence.transport, "http-sse");
  const noStore = (r) =>
    assert(
      typeof r.cache_control === "string" &&
        r.cache_control
          .toLowerCase()
          .split(",")
          .some((directive) => directive.trim() === "no-store"),
      "actual refusal must contain a complete no-store directive",
    );
  const config = evidence.rejections;
  assert.equal(config.request_timeout_ms, 2000);
  assert.equal(evidence.settings.resolveTTLMS, 10000);
  const start = evidence.identity.stopped.at,
    finish = evidence.identity.restart_started_at;
  assert(
    Number.isFinite(start) && Number.isFinite(finish) && finish - start >= 5000,
  );
  assert.equal(evidence.identity.stopped.running, false);
  assert.equal(evidence.identity.stopped_end.running, false);
  const row = (label) =>
    one(
      evidence.http.filter((r) => r.label === label),
      `actual ${label} response missing or duplicate`,
    );
  const login = (label) => {
    const r = row(label);
    assert.equal(r.path, "/api/session/login");
    assert.equal(r.method, "POST");
    assert.equal(r.status, 200);
    assert.equal(r.set_cookie_count, 2);
    assert(r.at < start);
    scopeID(r.issued_credential_scope);
    return r.issued_credential_scope;
  };
  const consoleScope = login("cold-console-login"),
    workspaceScope = login("cold-workspace-login"),
    expiredScope = login("short-idle-login"),
    warmScope = login("warm-login");
  assert.equal(
    new Set([
      consoleScope,
      workspaceScope,
      expiredScope,
      warmScope,
      login("audit-login"),
    ]).size,
    5,
    "outage credential scopes must be distinct",
  );
  const fixture = config.expired_session;
  assert.equal(fixture.credential_scope, expiredScope);
  assert.equal(fixture.idle_ms, 2000);
  assert.equal(fixture.only_idle_changed, true);
  assert.deepEqual(fixture.no_match_probe, {
    matches: 0,
    updated: 0,
    unchanged: true,
  });
  assert.equal(fixture.protected_unchanged, 2);
  assert(
    Number.isFinite(fixture.at) && row("short-idle-login").at < fixture.at,
  );
  for (const key of ["expires_at", "idle_expires_at"])
    assert.equal(
      Date.parse(row("short-idle-login").body[key]),
      Date.parse(fixture.before[key]),
    );
  assert(
    Date.parse(fixture.after.idle_expires_at) <
      Date.parse(fixture.before.idle_expires_at),
  );
  for (const key of ["expires_at", "last_used_at", "issued_at"])
    assert.equal(fixture.before[key], fixture.after[key]);
  const observation = (label) =>
    one(
      fixture.observations.filter((r) => r.label === label),
      `database ${label} observation missing`,
    );
  for (const [label, database] of [
    ["short-idle-warm", "after-warm"],
    ["short-idle-hit", "after-hit"],
  ]) {
    const r = row(label),
      db = observation(database);
    assert.equal(r.path, "/api/session");
    assert.equal(r.method, "GET");
    assert.equal(r.status, 200);
    assert.equal(r.set_cookie_count, 0);
    assert.equal(r.credential_scope, expiredScope);
    assert(
      r.started_at > fixture.at,
      "short session resolved before deadline fixture",
    );
    assert(r.at < db.at && db.at < start && !db.expired && db.remaining_ms > 0);
    for (const key of ["idle_expires_at", "expires_at"])
      assert.equal(Date.parse(r.body[key]), Date.parse(fixture.after[key]));
  }
  const expired = observation("expired");
  assert.equal(expired.expired, true);
  assert(expired.remaining_ms <= 0);
  assert(
    expired.at >= start &&
      expired.at <= row("stopped-expired-session").started_at,
  );
  for (const db of fixture.observations)
    for (const key of Object.keys(fixture.after))
      assert.equal(
        db[key],
        fixture.after[key],
        "ordinary reads changed browser authority",
      );

  const agent = evidence.cold_agent,
    setup = evidence.cold_agent_setup;
  assert(
    typeof agent?.agent_id === "string" &&
      agent.agent_id.length > 0 &&
      agent.agent_id !== evidence.agent_id,
    "cold cache key requires a distinct ready Agent",
  );
  const owner = row("warm-login").body?.principal?.user_id;
  assert(typeof owner === "string" && owner.length > 0, "warm owner missing");
  assert.equal(agent.owner_user_id, owner, "cold Agent has a different owner");
  assert.equal(agent.desired_state, "enabled");
  assert.equal(agent.activation_state, "enabled");
  assert.equal(agent.runtime_state, "available");
  assert(
    typeof agent.executable_execution_revision === "string" &&
      agent.executable_execution_revision.length > 0,
  );
  assert.equal(
    agent.last_successful_execution_revision,
    agent.executable_execution_revision,
  );
  assert.equal(setup?.agent_id, agent.agent_id, "different cold Agent setup");
  assert.equal(setup.owner_user_id, owner);
  assert.equal(
    setup.executable_execution_revision,
    agent.executable_execution_revision,
  );
  assert(
    Number.isFinite(setup.ready_at) && setup.ready_at < start,
    "cold Agent must be ready before the stop",
  );
  const workspacePath = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}/sessions/${encodeURIComponent(evidence.session_id)}/view`;
  const hit = row("warm-workspace-hit");
  assert.equal(hit.credential_scope, warmScope, "warm credential differs");
  assert.equal(hit.method, "GET");
  assert.equal(hit.path, workspacePath);
  assert.equal(hit.status, 200);
  assert.equal(hit.set_cookie_count, 0);
  assert.equal(hit.issued_credential_scope, undefined);
  assert(
    Number.isFinite(hit.started_at) &&
      Number.isFinite(hit.at) &&
      hit.started_at > row("warm-login").at &&
      hit.at >= hit.started_at &&
      hit.at < start,
    "warm cache hit must complete before the stop",
  );

  // SSE admission can warm a cache key before the stream closes. Inspect both
  // outage and recovery stream inventories together with every HTTP request.
  const streams = [
    evidence.stream,
    ...(evidence.recovery?.cases ?? []).map((c) => c.stream),
  ]
    .filter(Boolean)
    .map((stream) => {
      scopeID(stream.credential_scope);
      return { ...stream, method: "GET" };
    });
  const history = [...evidence.http, ...streams];
  for (const request of history) {
    assert(
      Number.isFinite(request.started_at),
      "cache-key history lacks request time",
    );
    assert(
      typeof request.path === "string" && request.path.startsWith("/"),
      "cache-key history lacks request path",
    );
    if (request.credential_scope !== null) scopeID(request.credential_scope);
    else
      assert(
        request.path === "/api/session/login" && request.method === "POST",
        "unauthenticated history must be an actual login request",
      );
  }
  const cases = [
    [
      "stopped-cold-console",
      "console",
      "/api/admin/execution-synchronization",
      "GET",
      consoleScope,
    ],
    [
      "stopped-cold-workspace",
      "workspace",
      workspacePath,
      "GET",
      workspaceScope,
    ],
    ["stopped-cold-profile", "session", "/api/session", "GET", warmScope],
    [
      "stopped-cold-agent",
      "workspace",
      `/api/app/workspace/v1/agents/${encodeURIComponent(agent.agent_id)}/sessions`,
      "GET",
      warmScope,
    ],
    ["stopped-new-login", null, "/api/session/login", "POST", null],
    ["stopped-expired-session", "session", "/api/session", "GET", expiredScope],
  ];
  const requests = cases.map(([label, profile, path, method, scope]) => {
    const r = row(label);
    assert.equal(r.path, path);
    assert.equal(r.method, method);
    assert(
      Number.isFinite(r.started_at) &&
        Number.isFinite(r.at) &&
        r.started_at >= start &&
        r.at >= r.started_at &&
        r.at <= finish &&
        r.at <= start + 5000,
      "complete HTTP failure must be inside original five-second stop",
    );
    assert.equal(r.status, 503);
    noStore(r);
    assert.equal(r.body?.code, "identity_unavailable");
    assert(
      typeof r.body.message === "string" && r.body.message.length > 0,
      "actual HTTP error message missing",
    );
    assert.equal(r.set_cookie_count, 0);
    assert.equal(
      r.credential_scope,
      scope,
      scope === warmScope
        ? "original warm credential required"
        : "wrong refusal credential",
    );
    assert.equal(r.issued_credential_scope, undefined);
    if (scope === warmScope) {
      for (const prior of history.filter(
        (other) =>
          other !== r &&
          other.credential_scope === scope &&
          other.started_at < r.started_at,
      )) {
        const key = historyKey(prior.path);
        if (key.profile !== profile) continue;
        if (profile === "session")
          assert.fail("cold profile was already used by the warm credential");
        assert.notEqual(
          key.agent,
          agent.agent_id,
          "cold Agent was already used by the warm credential",
        );
      }
    } else if (label.startsWith("stopped-cold-"))
      assert(
        !history.some(
          (other) =>
            other !== r &&
            other.credential_scope === scope &&
            other.started_at < r.started_at,
        ),
        "cold credential was already used before stop",
      );
    return { label, profile, status: 503, elapsed_ms: r.at - r.started_at };
  });

  const recovered = row("recovered-expired-session");
  assert.equal(recovered.path, "/api/session");
  assert.equal(recovered.method, "GET");
  assert(
    Number.isFinite(recovered.started_at) &&
      Number.isFinite(recovered.at) &&
      recovered.started_at > finish &&
      recovered.at >= recovered.started_at,
    "complete expired-session response after restart required",
  );
  assert.equal(recovered.credential_scope, expiredScope);
  assert.equal(recovered.status, 401);
  noStore(recovered);
  assert.equal(recovered.set_cookie_count, 0);
  assert.equal(recovered.issued_credential_scope, undefined);
  assert.equal(recovered.body?.code, "unauthenticated");
  assert(
    typeof recovered.body.message === "string" &&
      recovered.body.message.length > 0,
  );

  const workspaceRecovery = row("recovered-workspace-view");
  assert.equal(workspaceRecovery.path, workspacePath);
  assert.equal(workspaceRecovery.method, "GET");
  assert.equal(workspaceRecovery.status, 200);
  assert.equal(workspaceRecovery.credential_scope, warmScope);
  noStore(workspaceRecovery);
  assert.equal(workspaceRecovery.set_cookie_count, 0);
  assert.equal(workspaceRecovery.issued_credential_scope, undefined);
  assert(
    Number.isFinite(workspaceRecovery.started_at) &&
      Number.isFinite(workspaceRecovery.at) &&
      workspaceRecovery.started_at > finish &&
      workspaceRecovery.at >= workspaceRecovery.started_at,
    "complete workspace response after restart required",
  );

  return {
    status: "passed",
    requests,
    expired_recovery: { status: 401 },
    workspace_recovery: { status: 200 },
  };
}
