import assert from "node:assert/strict";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const finite = (value) =>
  assert(Number.isFinite(value), "missing resource observation time");

function transition(evidence, row, service, restart) {
  assert(row, "actual consumer lifecycle missing");
  const { before, after, started_at: started } = row;
  assert(before?.id && after);
  for (const state of [before, after]) {
    assert.equal(state.id, before.id, "consumer container replaced");
    assert.equal(state.project, evidence.project);
    assert.equal(state.service, service);
    assert.equal(state.restarting, false);
    assert.equal(state.oom_killed, false);
    assert.equal(state.exit_code, 0);
    finite(state.at);
    assert(Number.isSafeInteger(state.observed_at_ms));
  }
  assert.equal(before.running, true);
  assert.equal(before.health, "healthy");
  assert.equal(after.running, restart);
  if (restart) assert.equal(after.health, "healthy");
  finite(started);
  assert(
    before.at <= started && started < after.at,
    "invalid lifecycle observation order",
  );
  const old = Date.parse(before.started_at),
    finished = Date.parse(after.finished_at),
    current = Date.parse(after.started_at);
  [old, finished, current].forEach(finite);
  // Docker's process timestamps share the daemon's clock, not the runner's
  // wall clock. The observed state transition supplies the monotonic window.
  assert(old < finished, "unproved normal process termination");
  if (restart) assert(finished < current, "consumer process did not restart");
  else assert.equal(current, old, "drain process replaced");
  return row;
}

function identityLifecycle(evidence) {
  const {
    before,
    stopped,
    stopped_end: stoppedEnd,
    after,
    healthy,
    stop_started_at: stopAt,
    stop_started_at_ms: stopMS,
    restart_started_at: restartAt,
    restart_started_at_ms: restartMS,
  } = evidence.identity;
  assert(typeof before.id === "string" && before.id.length > 0);
  for (const state of [before, stopped, stoppedEnd, after, healthy]) {
    assert.equal(state.id, before.id, "Identity container replaced");
    assert.equal(state.project, evidence.project, "wrong Identity project");
    assert.equal(state.service, "identity-service");
    assert.equal(state.restarting, false);
    assert.equal(state.oom_killed, false);
    assert.equal(state.exit_code, 0);
    assert(
      Number.isFinite(state.at) && Number.isSafeInteger(state.observed_at_ms),
    );
  }
  for (const state of [before, after, healthy])
    assert.equal(state.running, true);
  for (const state of [stopped, stoppedEnd]) {
    assert.equal(state.running, false);
    assert.equal(state.started_at, before.started_at);
    assert.equal(state.finished_at, stopped.finished_at);
  }
  assert.equal(before.health, "healthy");
  assert.equal(healthy.health, "healthy");
  assert.equal(after.started_at, healthy.started_at);
  assert.notEqual(after.started_at, before.started_at);
  assert.equal(after.finished_at, stopped.finished_at);
  assert.equal(healthy.finished_at, stopped.finished_at);
  assert(Number.isFinite(stopAt) && Number.isSafeInteger(stopMS));
  assert(Number.isFinite(restartAt) && Number.isSafeInteger(restartMS));
  assert(
    before.at <= stopAt &&
      stopAt <= stopped.at &&
      stoppedEnd.at >= stopped.at + 5000 &&
      restartAt >= stoppedEnd.at &&
      after.at >= restartAt &&
      healthy.at >= after.at,
  );
  const finished = Date.parse(stopped.finished_at),
    started = Date.parse(after.started_at);
  assert(Number.isFinite(finished) && Number.isFinite(started));
  assert(
    before.observed_at_ms <= stopMS &&
      stopMS <= finished &&
      finished <= stopped.observed_at_ms &&
      stopped.observed_at_ms <= stoppedEnd.observed_at_ms &&
      stoppedEnd.observed_at_ms <= restartMS &&
      restartMS <= started &&
      started <= after.observed_at_ms &&
      after.observed_at_ms <= healthy.observed_at_ms,
    "invalid Identity stop/restart observations",
  );
}

export function inspectOutageBusinessResources(evidence) {
  for (const field of ["failure", "finalization_errors"])
    assert(
      !Object.hasOwn(evidence, field),
      "outage business or resource failure recorded",
    );
  assert(Array.isArray(evidence.http), "actual HTTP inventory missing");
  assert(
    Array.isArray(evidence.consumer_restarts),
    "consumer lifecycle inventory missing",
  );
  assert.deepEqual(
    evidence.consumer_restarts.map((row) => row.service).sort(),
    ["agent-acp-service", "agent-ui"],
  );
  const cases = evidence.recovery?.cases;
  assert(Array.isArray(cases), "recovery resource inventory missing");
  assert.deepEqual(
    cases.map((c) => c.name),
    ["logout", "password", "role", "deactivate"],
  );
  for (const c of cases)
    for (const field of ["failure", "cleanup_errors"])
      assert(
        !Object.hasOwn(c, field),
        "recovery business or resource failure recorded",
      );

  identityLifecycle(evidence);
  const acp = transition(
    evidence,
    one(
      evidence.consumer_restarts.filter(
        (row) => row.service === "agent-acp-service",
      ),
      "one ACP restart required",
    ),
    "agent-acp-service",
    true,
  );
  const ui = transition(
    evidence,
    one(
      evidence.consumer_restarts.filter((row) => row.service === "agent-ui"),
      "one UI restart required",
    ),
    "agent-ui",
    true,
  );
  const drain = transition(evidence, evidence.ui_drain, "agent-ui", false);
  assert.equal(drain.log_checked, true, "UI stop log was not checked");
  assert.equal(drain.forced_drain, false, "UI drain was forced");
  assert.match(drain.log_sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(drain.before.id, ui.after.id, "drain of different UI container");
  assert.equal(
    drain.before.started_at,
    ui.after.started_at,
    "drain of different UI process",
  );

  const fields = ["label", "method", "path", "started_at", "at"];
  const sameHTTP = (row) => {
    assert(row && typeof row === "object", "actual HTTP response missing");
    assert.deepEqual(
      one(
        evidence.http.filter((candidate) =>
          fields.every((field) => candidate[field] === row[field]),
        ),
        "actual HTTP response missing or duplicate",
      ),
      row,
      "changed actual HTTP response",
    );
  };
  const byLabel = (label) =>
    one(
      evidence.http.filter((row) => row.label === label),
      `actual ${label} missing`,
    );
  const loginScope = (row) => {
    sameHTTP(row);
    assert.equal(row.path, "/api/session/login");
    assert.equal(row.method, "POST");
    assert.equal(row.status, 200);
    assert.equal(row.set_cookie_count, 2);
    assert(
      typeof row.issued_credential_scope === "string" &&
        row.issued_credential_scope,
    );
    finite(row.at);
    return row.issued_credential_scope;
  };
  const warmLogin = byLabel("warm-login"),
    prepLogin = byLabel("prep-login"),
    adminLogin = byLabel("audit-login");
  const warmScope = loginScope(warmLogin),
    prepScope = loginScope(prepLogin),
    adminScope = loginScope(adminLogin),
    scopes = cases.map((c) => loginScope(c.login));
  assert.notEqual(
    warmScope,
    adminScope,
    "distinct credentials collapsed to one scope",
  );
  assert.equal(
    new Set([warmScope, prepScope, ...scopes]).size,
    cases.length + 2,
    "independent credentials collapsed",
  );
  const password = cases[1];
  for (const field of ["user_id", "membership_id", "organization_id"]) {
    assert(warmLogin.body?.principal?.[field], "warm principal missing");
    assert.equal(
      password.login.body?.principal?.[field],
      warmLogin.body.principal[field],
      "password changed another member",
    );
  }
  for (const c of cases) {
    const principal = c.login.body.principal;
    assert.equal(c.agent_id, evidence.agent_id);
    assert.equal(c.owner_id, principal.user_id);
    assert.equal(principal.active, true);
    for (const field of ["organization_id", "user_id", "membership_id"])
      assert(
        typeof principal[field] === "string" && principal[field].length > 0,
      );
  }

  const principal = evidence.session_deadlines.owner.principal;
  const loginFor = (row) => {
    const login = one(
      evidence.http.filter(
        (candidate) =>
          candidate.path === "/api/session/login" &&
          candidate.issued_credential_scope === row.credential_scope,
      ),
      "actual dispatched credential login",
    );
    loginScope(login);
    assert(login.at < row.started_at);
    assert.equal(
      login.body.principal.organization_id,
      principal.organization_id,
    );
    return login;
  };
  for (const row of [
    evidence.prompt,
    evidence.cancel,
    evidence.audit_before,
    evidence.audit,
    evidence.consumer_configuration.synchronization,
    evidence.consumer_configuration.state,
  ]) {
    sameHTTP(row);
    loginFor(row);
  }
  assert.deepEqual(
    loginFor(evidence.prompt).body.principal,
    principal,
    "actual owner Principal differs",
  );
  assert.equal(evidence.prompt.credential_scope, warmScope);
  assert.equal(
    evidence.cancel.credential_scope,
    evidence.prompt.credential_scope,
  );

  const base = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}`;
  const prewarm = (row, path, login) => {
    sameHTTP(row);
    assert.equal(row.method, "GET");
    assert.equal(row.path, path);
    assert.equal(row.status, 200);
    assert.equal(row.set_cookie_count, 0);
    assert.equal(
      row.credential_scope,
      login.issued_credential_scope,
      "dispatched credential differs from original login",
    );
    finite(row.started_at);
    finite(row.at);
    assert(
      login.at <= row.started_at &&
        row.started_at <= row.at &&
        row.at < evidence.identity.stop_started_at,
      "prewarm response did not precede Identity stop",
    );
  };
  prewarm(
    byLabel("warm-console-audit"),
    `/api/admin/execution-audits/${encodeURIComponent(evidence.run_id)}`,
    adminLogin,
  );
  prewarm(
    evidence.consumer_configuration.synchronization,
    "/api/admin/execution-synchronization",
    adminLogin,
  );
  prewarm(evidence.consumer_configuration.state, `${base}/view`, warmLogin);

  const views = [
    {
      row: byLabel("prep-view"),
      scope: prepScope,
      lifecycle: acp,
      login: prepLogin,
    },
    ...["warm-workspace-view", "recovered-workspace-view"].map((label) => ({
      row: byLabel(label),
      scope: warmScope,
      lifecycle: drain,
      login: warmLogin,
    })),
  ];
  for (const item of views) {
    const row = item.row;
    sameHTTP(row);
    assert.equal(
      row.path,
      `${base}/sessions/${encodeURIComponent(evidence.session_id)}/view`,
    );
    assert.equal(row.method, "GET");
    assert.equal(row.status, 200);
    assert.equal(row.set_cookie_count, 0);
    assert.equal(row.credential_scope, item.scope);
    finite(row.started_at);
    finite(row.at);
    assert(item.login.at <= row.started_at && row.started_at <= row.at);
    assert(
      row.at < item.lifecycle.started_at,
      "view after closing lifecycle began",
    );
  }

  const streamItems = [
    {
      stream: evidence.stream,
      session_id: evidence.session_id,
      scope: warmScope,
      mutation: password,
    },
    ...cases.map((c, index) => ({
      stream: c.stream,
      session_id: c.session_id,
      scope: scopes[index],
      mutation: c,
    })),
  ];
  const epochs = new Map();
  for (const row of evidence.http) {
    if (
      row.method !== "GET" ||
      row.status !== 200 ||
      !row.path?.startsWith(`${base}/`) ||
      !row.path.endsWith("/view")
    )
      continue;
    assert.equal(
      row.body?.agentId,
      evidence.agent_id,
      "owner view Agent differs",
    );
    if (row.path.startsWith(`${base}/sessions/`))
      assert.equal(
        row.path,
        `${base}/sessions/${encodeURIComponent(row.body.sessionId)}/view`,
        "owner view Session differs",
      );
    assert(
      typeof row.body.bridgeEpoch === "string" &&
        row.body.bridgeEpoch.length > 0,
      "successful owner view epoch missing",
    );
    finite(row.started_at);
    finite(row.at);
    assert(row.started_at <= row.at);
    const generation = row.at < ui.started_at ? 0 : 1;
    if (generation === 1)
      assert(row.started_at >= ui.after.at, "view overlaps UI restart");
    if (epochs.has(generation))
      assert.equal(
        row.body.bridgeEpoch,
        epochs.get(generation),
        "inconsistent UI generation epoch",
      );
    else epochs.set(generation, row.body.bridgeEpoch);
  }
  assert.equal(epochs.size, 2, "both actual UI generation witnesses required");
  assert.notEqual(
    epochs.get(0),
    epochs.get(1),
    "UI epoch survived observed restart",
  );
  for (const item of streamItems) {
    const { stream, mutation } = item,
      closure = stream.closure;
    assert.equal(
      stream.path,
      `${base}/events?sessionId=${encodeURIComponent(item.session_id)}`,
    );
    assert.equal(stream.credential_scope, item.scope);
    assert.equal(stream.status, 200);
    assert.equal(stream.set_cookie_count, 0);
    assert(
      ["transport-end", "remote-end"].includes(closure?.kind),
      "actual remote stream retirement missing",
    );
    [
      stream.started_at,
      stream.headers_at,
      closure.at,
      mutation.trigger.at,
    ].forEach(finite);
    assert(
      Number.isSafeInteger(closure.observed_at_ms) &&
        Number.isSafeInteger(mutation.trigger.observed_at_ms),
    );
    assert(
      stream.started_at <= stream.headers_at &&
        stream.headers_at < mutation.trigger.at &&
        closure.at >= mutation.trigger.at &&
        closure.at <= mutation.trigger.at + 30000,
      "stream closed outside mutation window",
    );
    assert(
      closure.observed_at_ms >= mutation.trigger.observed_at_ms &&
        closure.observed_at_ms <= mutation.trigger.observed_at_ms + 30000,
    );
    assert(stream.joined, "actual stream join missing");
    finite(stream.joined.at);
    assert(Number.isSafeInteger(stream.joined.observed_at_ms));
    assert(
      closure.at <= stream.joined.at && stream.joined.at < drain.started_at,
      "UI drained before public stream join",
    );
    sameHTTP(mutation.mutation);
    const path =
      mutation.name === "logout"
        ? "/api/session"
        : mutation.name === "password"
          ? "/api/session/password"
          : `/api/admin/directory/memberships/${encodeURIComponent(mutation.login.body.principal.membership_id)}`;
    assert.equal(mutation.mutation.path, path);
    assert.equal(
      mutation.mutation.method,
      mutation.name === "logout" ? "DELETE" : "POST",
    );
    assert.equal(
      mutation.mutation.status,
      mutation.name === "logout" ? 204 : 200,
    );
    if (["logout", "password"].includes(mutation.name))
      assert.equal(
        mutation.mutation.credential_scope,
        mutation.login.issued_credential_scope,
      );
    assert(
      mutation.trigger.at <= mutation.mutation.started_at &&
        mutation.mutation.started_at <= mutation.mutation.at &&
        mutation.mutation.started_at <= closure.at,
    );
  }

  for (const row of evidence.http)
    if (row.status === 401) assert.equal(row.body?.code, "unauthenticated");
  for (const c of cases)
    if (c.restore) {
      sameHTTP(c.restore);
      assert.equal(c.restore.credential_scope, c.mutation.credential_scope);
      assert.equal(c.restore.credential_scope, adminScope);
      assert.equal(
        c.restore.body.membership.user_id,
        c.login.body.principal.user_id,
      );
      assert.equal(c.restore.body.membership.role, "admin");
    }

  const runtime = evidence.runtime,
    generation = runtime.started.status.generation;
  assert(
    Number.isSafeInteger(generation) && generation > 0,
    "actual Runtime generation missing",
  );
  assert.equal(runtime.container.generation, generation);
  for (const row of [
    runtime.started,
    runtime.before_cancel,
    runtime.quiescent,
  ]) {
    assert.equal(row.status.agent_id, evidence.agent_id);
    assert.equal(row.status.generation, generation);
  }
  return {
    status: "passed",
    public_streams: 5,
    consumer_processes: 2,
    ui_stopped: true,
  };
}
