import {
  resolutionFixture,
  resolvePrefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

function failed(span, type, message, causes, stage) {
  for (const [key, value] of Object.entries({
    error: true,
    "error.type": type,
    "otel.status_code": "ERROR",
    "otel.status_description": message,
  }))
    setTag(span, key, value);
  span.logs = stage
    ? [
        {
          timestamp: span.startTime + span.duration,
          fields: Object.entries({
            event: "antnest.error",
            "error.type": type,
            "antnest.error.stage": stage,
            "antnest.error.message": message,
            "antnest.error.cause_types": JSON.stringify(causes),
          }).map(([key, value]) => ({ key, value })),
        },
      ]
    : [];
}

function fixture(policyRevision = 3) {
  const traces = new Map(),
    rows = {},
    parts = {};
  const scope = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const evidence = {
    policy_revision: policyRevision,
    ...(policyRevision === 4 ? { transport: "http-sse" } : {}),
    agent_id: "agent",
    session_id: "chat",
    settings: { resolveTTLMS: 10000, captureRpcContent: false },
    identity: {
      stopped: { at: 10000, running: false },
      stopped_end: { at: 15050, running: false },
      restart_started_at: 15100,
    },
    http: [],
    rejections: {
      request_timeout_ms: 2000,
      expired_session: {
        credential_scope: scope(3),
        idle_ms: 2000,
        only_idle_changed: true,
        no_match_probe: { matches: 0, updated: 0, unchanged: true },
        protected_unchanged: 2,
        at: 7800,
        before: {
          idle_expires_at: "2026-10-12T10:30:00Z",
          expires_at: "2026-10-12T22:00:00Z",
          last_used_at: "2026-10-12T10:00:00Z",
          issued_at: "2026-10-12T10:00:00Z",
        },
        after: {
          idle_expires_at: "2026-10-12T10:00:02Z",
          expires_at: "2026-10-12T22:00:00Z",
          last_used_at: "2026-10-12T10:00:00Z",
          issued_at: "2026-10-12T10:00:00Z",
        },
        observations: [],
      },
    },
  };
  let n = 1;
  const add = (
    label,
    profile,
    path,
    method,
    status,
    source,
    time,
    credential_scope,
  ) => {
    const f = resolutionFixture(source === "cache" ? "cache" : "rpc");
    f.trace.traceID = (n++).toString(16).padStart(32, "0");
    for (const s of f.trace.spans) {
      s.traceID = f.trace.traceID;
      for (const ref of s.references) ref.traceID = f.trace.traceID;
    }
    f.trace.spans = f.trace.spans.filter((s) => s !== f.upstream);
    setTag(
      f.root,
      "http.route",
      path.startsWith("/api/admin/")
        ? "/api/admin/{path...}"
        : path.startsWith("/api/app/workspace/")
          ? "/api/app/workspace/v1/{path...}"
          : path.includes("/v1/acp")
            ? "/api/app/agents/{agent_id}/v1/acp"
            : path,
    );
    setTag(f.root, "http.request.method", method);
    setTag(f.root, "http.response.status_code", status);
    setTag(f.decision, resolvePrefix + "profile", profile);
    const client = f.trace.spans.find((s) => s.spanID === "resolve-client");
    if (client) {
      setTag(client, "server.address", "identity-service");
      setTag(client, "server.port", 8080);
    }
    if (!profile) f.trace.spans = f.trace.spans.filter((s) => s !== f.decision);
    if (status === 503) {
      f.trace.spans = f.trace.spans.filter(
        (s) => !["resolve-server", "sql"].includes(s.spanID),
      );
      failed(
        f.root,
        profile ? "network_error" : "deadline_exceeded",
        profile ? "Network operation failed" : "Request deadline exceeded",
        profile
          ? ["*fmt.wrapError", "*url.Error", "*net.OpError", "*os.SyscallError"]
          : ["*fmt.wrapError", "*url.Error", "context.deadlineExceededError"],
        "request",
      );
      setTag(client, "http.response.status_code", undefined);
      failed(
        client,
        profile ? "network_error" : "deadline_exceeded",
        profile ? "Network operation failed" : "Request deadline exceeded",
        profile
          ? ["*net.OpError", "*os.SyscallError", "syscall.Errno"]
          : ["context.deadlineExceededError"],
        "send",
      );
      setTag(client, "antnest.request.timeout_ms", 1999);
      failed(f.decision, undefined, "unavailable");
      setTag(f.decision, resolvePrefix + "outcome", "unavailable");
    }
    if (status === 401) {
      failed(
        f.root,
        "operation_failed",
        "Operation failed; unclassified error text was not exported",
        ["*errors.errorString"],
        "request",
      );
      failed(client, "401", "HTTP status 401");
      failed(f.decision, undefined, "rejected");
      const server = f.trace.spans.find((s) => s.spanID === "resolve-server");
      const attributes = {
        "antnest.error.cause_types": '["*domain.Error"]',
        "antnest.error.code": "unauthenticated",
        "antnest.error.message": "Authentication failed",
        "antnest.error.stage": "protocol",
        "antnest.error.type": "unauthenticated",
        "error.type": "unauthenticated",
      };
      for (const [key, value] of Object.entries({
        ...attributes,
        "antnest.outcome": "rejected",
        "antnest.result": "rejected",
      }))
        setTag(server, key, value);
      server.logs = [
        {
          timestamp: server.startTime + server.duration,
          fields: Object.entries({ event: "antnest.error", ...attributes }).map(
            ([key, value]) => ({ key, value }),
          ),
        },
      ];
      setTag(f.decision, resolvePrefix + "outcome", "rejected");
      for (const s of f.trace.spans.filter((s) =>
        ["resolve-server", "resolve-client"].includes(s.spanID),
      ))
        setTag(s, "http.response.status_code", 401);
      const sql = f.trace.spans.find((s) => s.spanID === "sql");
      setTag(
        sql,
        "db.query.text",
        "SELECT t.id, t.expires_at, t.idle_expires_at, u.id, m.organization_id, m.id, u.system_role, m.role, u.active, m.active, o.active, o.slug, o.name FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN organization_memberships m ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id JOIN organizations o ON o.id = t.organization_id WHERE t.token_hash = $1 AND t.kind = 'browser' AND t.revoked_at IS NULL AND t.expires_at > $2 AND t.idle_expires_at > $2 AND m.scim_deleted_at IS NULL",
      );
      setTag(sql, "pgx.rows_affected", 0);
    }
    if (source === "cache") {
      setTag(f.decision, resolvePrefix + "snapshot_age_ms", 50);
      setTag(f.decision, resolvePrefix + "valid_for_ms", 1500);
    }
    const row = {
      label,
      credential_scope,
      method,
      path,
      status,
      cache_control: "no-store",
      set_cookie_count: 0,
      trace_id: f.trace.traceID,
      started_at: time,
      at: time + 100,
      body:
        status === 503
          ? { code: "identity_unavailable", message: "Identity is unavailable" }
          : status === 401
            ? { code: "unauthenticated", message: "Session is expired" }
            : {},
    };
    evidence.http.push(row);
    traces.set(f.trace.traceID, f.trace);
    rows[label] = row;
    parts[label] = f;
    return row;
  };
  for (const [label, i] of [
    ["cold-console-login", 1],
    ["cold-workspace-login", 2],
    ["short-idle-login", 3],
    ["warm-login", 4],
    ["audit-login", 5],
  ]) {
    const row = add(
      label,
      null,
      "/api/session/login",
      "POST",
      200,
      "rpc",
      1000,
      null,
    );
    row.issued_credential_scope = scope(i);
    row.set_cookie_count = 2;
    if (label === "short-idle-login")
      row.body = { ...evidence.rejections.expired_session.before };
    if (label === "warm-login") row.body = { principal: { user_id: "owner" } };
  }
  for (const [label, source, time] of [
    ["short-idle-warm", "rpc", 8000],
    ["short-idle-hit", "cache", 8500],
  ]) {
    const row = add(
      label,
      "session",
      "/api/session",
      "GET",
      200,
      source,
      time,
      scope(3),
    );
    row.body = { ...evidence.rejections.expired_session.after };
  }
  for (const [label, profile, path, method, i, time] of [
    [
      "stopped-cold-console",
      "console",
      "/api/admin/execution-synchronization",
      "GET",
      1,
      10100,
    ],
    [
      "stopped-cold-workspace",
      "workspace",
      "/api/app/workspace/v1/agents/agent/sessions/chat/view",
      "GET",
      2,
      10100,
    ],
    ...(policyRevision === 4
      ? [
          ["stopped-cold-profile", "session", "/api/session", "GET", 4, 10100],
          [
            "stopped-cold-agent",
            "workspace",
            "/api/app/workspace/v1/agents/cold-agent/sessions",
            "GET",
            4,
            10100,
          ],
        ]
      : [
          [
            "stopped-cold-acp",
            "acp",
            "/api/app/agents/agent/v1/acp",
            "POST",
            2,
            10100,
          ],
        ]),
    ["stopped-new-login", null, "/api/session/login", "POST", null, 10100],
    ["stopped-expired-session", "session", "/api/session", "GET", 3, 12200],
  ])
    add(label, profile, path, method, 503, "rpc", time, i ? scope(i) : null);
  add(
    "recovered-expired-session",
    "session",
    "/api/session",
    "GET",
    401,
    "rpc",
    16000,
    scope(3),
  );
  const metadata = evidence.rejections.expired_session;
  metadata.observations = [
    {
      ...metadata.after,
      label: "after-warm",
      at: 8200,
      expired: false,
      remaining_ms: 1700,
    },
    {
      ...metadata.after,
      label: "after-hit",
      at: 8700,
      expired: false,
      remaining_ms: 1200,
    },
    {
      ...metadata.after,
      label: "expired",
      at: 12100,
      expired: true,
      remaining_ms: -10,
    },
  ];
  if (policyRevision === 4) {
    evidence.cold_agent = {
      agent_id: "cold-agent",
      owner_user_id: "owner",
      desired_state: "enabled",
      activation_state: "enabled",
      runtime_state: "available",
      executable_execution_revision: "execution-cold",
      last_successful_execution_revision: "execution-cold",
    };
    evidence.cold_agent_setup = {
      agent_id: "cold-agent",
      owner_user_id: "owner",
      executable_execution_revision: "execution-cold",
      ready_at: 7000,
    };
    add(
      "warm-workspace-hit",
      "workspace",
      "/api/app/workspace/v1/agents/agent/sessions/chat/view",
      "GET",
      200,
      "cache",
      9000,
      scope(4),
    );
  }
  const archivedTraceIDs = new Set(traces.keys());
  return {
    evidence,
    collection: { traces, archivedTraceIDs },
    rows,
    parts,
    add: (...args) => {
      const row = add(...args);
      archivedTraceIDs.add(row.trace_id);
      return row;
    },
  };
}

export { fixture as outageRejectionFixture, failed };
