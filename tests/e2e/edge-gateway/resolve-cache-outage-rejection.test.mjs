import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageRejections } from "./resolve-cache-outage-rejection.mjs";
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

test("Bridge outage proves six refusals including a warm Cookie's cold profile and Agent", () => {
  const f = fixture(4);
  const before = structuredClone([...f.collection.traces]);
  const result = inspectOutageRejections(f.evidence, f.collection);
  assert.equal(result.status, "passed");
  assert.deepEqual(
    result.requests.map(({ label, profile }) => [label, profile]),
    [
      ["stopped-cold-console", "console"],
      ["stopped-cold-workspace", "workspace"],
      ["stopped-cold-profile", "session"],
      ["stopped-cold-agent", "workspace"],
      ["stopped-new-login", null],
      ["stopped-expired-session", "session"],
    ],
  );
  assert.equal(result.expired_recovery.status, 401);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.owned_error_spans.length, 21);
  const claimed = new Set(
    result.owned_error_spans.map((s) => `${s.trace_id}:${s.span_id}`),
  );
  for (const [label, p] of Object.entries(f.parts))
    if (label.startsWith("stopped-"))
      for (const s of p.trace.spans)
        assert(claimed.has(`${s.traceID}:${s.spanID}`));
  assert.deepEqual([...f.collection.traces], before);
});

for (const revision of [undefined, null, 2, 5, "4"])
  test(`rejection gate refuses an unrecognized evidence revision ${revision}`, () => {
    const f = fixture();
    f.evidence.policy_revision = revision;
    assert.throws(
      () => inspectOutageRejections(f.evidence, f.collection),
      /revision/u,
    );
  });

for (const cacheControl of [
  "no-store, no-store",
  "private, NO-STORE",
  " \tno-store\t ",
])
  test(`Bridge refusals preserve complete no-store directives: ${cacheControl}`, () => {
    const f = fixture(4);
    for (const r of f.evidence.http) r.cache_control = cacheControl;
    assert.equal(
      inspectOutageRejections(f.evidence, f.collection).status,
      "passed",
    );
  });

for (const [label, mutate, reason] of [
  [
    "a missing cold profile",
    (f) => {
      f.evidence.http = f.evidence.http.filter(
        (r) => r.label !== "stopped-cold-profile",
      );
    },
    /stopped-cold-profile/u,
  ],
  [
    "a missing cold Agent",
    (f) => {
      f.evidence.http = f.evidence.http.filter(
        (r) => r.label !== "stopped-cold-agent",
      );
    },
    /stopped-cold-agent/u,
  ],
  [
    "a duplicate cold Agent",
    (f) => f.evidence.http.push({ ...f.rows["stopped-cold-agent"] }),
    /stopped-cold-agent/u,
  ],
  [
    "a legacy transport",
    (f) => {
      f.evidence.transport = "wss";
    },
    /http-sse/u,
  ],
  [
    "an old ACP refusal substituted for the cold profile",
    (f) => {
      Object.assign(f.rows["stopped-cold-profile"], {
        label: "stopped-cold-acp",
        path: "/api/app/agents/agent/v1/acp",
        method: "POST",
      });
    },
    /stopped-cold-profile/u,
  ],
  [
    "the warm Agent substituted for the cold Agent",
    (f) => {
      f.evidence.cold_agent.agent_id = "agent";
      f.evidence.cold_agent_setup.agent_id = "agent";
      f.rows["stopped-cold-agent"].path =
        "/api/app/workspace/v1/agents/agent/sessions";
    },
    /distinct.*Agent/u,
  ],
  [
    "an unready cold Agent",
    (f) => {
      f.evidence.cold_agent.runtime_state = "unavailable";
    },
    /available/u,
  ],
  [
    "another owner's cold Agent",
    (f) => {
      f.evidence.cold_agent.owner_user_id = "other";
    },
    /owner/u,
  ],
  [
    "a cold Agent readied after the stop",
    (f) => {
      f.evidence.cold_agent_setup.ready_at = 10100;
    },
    /ready.*before/u,
  ],
  [
    "a different cold Agent setup",
    (f) => {
      f.evidence.cold_agent_setup.agent_id = "other";
    },
    /cold Agent setup/u,
  ],
  [
    "a new Cookie for the cold profile",
    (f) => {
      f.rows["stopped-cold-profile"].credential_scope =
        f.rows["cold-console-login"].issued_credential_scope;
    },
    /warm credential/u,
  ],
  [
    "a new Cookie for the cold Agent",
    (f) => {
      f.rows["stopped-cold-agent"].credential_scope =
        f.rows["cold-workspace-login"].issued_credential_scope;
    },
    /warm credential/u,
  ],
  [
    "no warm workspace hit",
    (f) => {
      f.evidence.http = f.evidence.http.filter(
        (r) => r.label !== "warm-workspace-hit",
      );
    },
    /warm-workspace-hit/u,
  ],
  [
    "a different warm hit Cookie",
    (f) => {
      f.rows["warm-workspace-hit"].credential_scope =
        f.rows["audit-login"].issued_credential_scope;
    },
    /warm credential/u,
  ],
  [
    "a late warm workspace hit",
    (f) => {
      f.rows["warm-workspace-hit"].at = 10100;
    },
    /warm.*before/u,
  ],
  [
    "an RPC substituted for a warm cache hit",
    (f) => {
      setTag(
        f.parts["warm-workspace-hit"].decision,
        resolvePrefix + "source",
        "rpc",
      );
    },
    undefined,
  ],
  [
    "an absent warm trace",
    (f) =>
      f.collection.archivedTraceIDs.delete(
        f.rows["warm-workspace-hit"].trace_id,
      ),
    /not archived/u,
  ],
  [
    "a prewarmed session profile",
    (f) =>
      f.add(
        "early-profile",
        "session",
        "/api/session",
        "GET",
        200,
        "rpc",
        8000,
        f.rows["warm-login"].issued_credential_scope,
      ),
    /cold profile.*already/u,
  ],
  [
    "a prewarmed Agent through another workspace route",
    (f) =>
      f.add(
        "early-agent",
        "workspace",
        "/api/app/workspace/v1/agents/cold-agent/view",
        "GET",
        200,
        "rpc",
        8000,
        f.rows["warm-login"].issued_credential_scope,
      ),
    /cold Agent.*already/u,
  ],
  [
    "an encoded prewarmed Agent route",
    (f) =>
      f.add(
        "early-agent",
        "workspace",
        "/api/app/workspace/v1/agents/%63old-agent/view",
        "GET",
        200,
        "rpc",
        8000,
        f.rows["warm-login"].issued_credential_scope,
      ),
    /cold Agent.*already/u,
  ],
  [
    "a cold profile first used between stop and refusal",
    (f) =>
      f.add(
        "early-profile",
        "session",
        "/api/session",
        "GET",
        503,
        "rpc",
        10050,
        f.rows["warm-login"].issued_credential_scope,
      ),
    /cold profile.*already/u,
  ],
])
  test(`Bridge refusal gate rejects ${label}`, () => {
    const f = fixture(4);
    mutate(f);
    assert.throws(
      () => inspectOutageRejections(f.evidence, f.collection),
      reason,
    );
  });

for (const label of ["stopped-cold-profile", "stopped-cold-agent"])
  for (const [name, mutate] of [
    [
      "late response",
      (f) => {
        f.rows[label].at = 15050;
      },
    ],
    [
      "new Cookie",
      (f) => {
        f.rows[label].set_cookie_count = 1;
      },
    ],
    [
      "issued credential",
      (f) => {
        f.rows[label].issued_credential_scope =
          f.rows["audit-login"].issued_credential_scope;
      },
    ],
    [
      "wrong profile",
      (f) =>
        setTag(f.parts[label].decision, resolvePrefix + "profile", "console"),
    ],
    [
      "cache source",
      (f) => setTag(f.parts[label].decision, resolvePrefix + "source", "cache"),
    ],
    [
      "business forwarding",
      (f) => f.parts[label].trace.spans.push(f.parts[label].upstream),
    ],
    [
      "missing Identity attempt",
      (f) => {
        f.parts[label].trace.spans = f.parts[label].trace.spans.filter(
          (s) => s.spanID !== "resolve-client",
        );
      },
    ],
    [
      "client timeout without response",
      (f) => {
        delete f.rows[label].status;
      },
    ],
  ])
    test(`${label} keeps the existing refusal invariant: ${name}`, () => {
      const f = fixture(4);
      mutate(f);
      assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
    });

for (const cacheControl of [
  undefined,
  "",
  "public",
  "no-store=1",
  "x-no-store",
  '"no-store"',
])
  for (const label of [
    "stopped-cold-profile",
    "stopped-cold-agent",
    "recovered-expired-session",
  ])
    test(`${label} rejects invalid cache-control ${JSON.stringify(cacheControl)}`, () => {
      const f = fixture(4);
      f.rows[label].cache_control = cacheControl;
      assert.throws(
        () => inspectOutageRejections(f.evidence, f.collection),
        /no-store/u,
      );
    });

test("different Bridge refusal receipts cannot reuse one real failure Trace", () => {
  const f = fixture(4);
  f.rows["stopped-cold-agent"].trace_id =
    f.rows["stopped-cold-workspace"].trace_id;
  assert.throws(
    () => inspectOutageRejections(f.evidence, f.collection),
    /Trace.*reused/u,
  );
});

for (const location of ["outage", "recovery"])
  test(`a ${location} SSE admission cannot silently prewarm the cold Agent`, () => {
    const f = fixture(4);
    const stream = f.add(
      "early-stream",
      "workspace",
      "/api/app/workspace/v1/agents/cold-agent/events?sessionId=other",
      "GET",
      200,
      "rpc",
      8000,
      f.rows["warm-login"].issued_credential_scope,
    );
    f.evidence.http = f.evidence.http.filter((r) => r !== stream);
    delete stream.method;
    stream.headers_at = stream.at;
    delete stream.at;
    if (location === "outage") f.evidence.stream = stream;
    else f.evidence.recovery = { cases: [{ stream }] };
    assert.throws(
      () => inspectOutageRejections(f.evidence, f.collection),
      /cold Agent.*already/u,
    );
  });

for (const location of ["outage", "recovery"])
  for (const scope of ["cold-console-login", "cold-workspace-login"])
    test(`the independent ${scope} remains cold across ${location} SSE requests`, () => {
      const f = fixture(4);
      const stream = f.add(
        "early-cold-stream",
        "workspace",
        "/api/app/workspace/v1/agents/agent/events",
        "GET",
        200,
        "rpc",
        8000,
        f.rows[scope].issued_credential_scope,
      );
      f.evidence.http = f.evidence.http.filter((r) => r !== stream);
      delete stream.method;
      stream.headers_at = stream.at;
      delete stream.at;
      if (location === "outage") f.evidence.stream = stream;
      else f.evidence.recovery = { cases: [{ stream }] };
      assert.throws(
        () => inspectOutageRejections(f.evidence, f.collection),
        /cold credential.*already/u,
      );
    });

for (const [field, value] of [
  ["credential_scope", undefined],
  ["credential_scope", null],
  ["started_at", undefined],
  ["started_at", NaN],
  ["path", undefined],
])
  test(`Bridge cache-key history cannot hide a SSE request with ${field}=${value}`, () => {
    const f = fixture(4);
    f.evidence.stream = {
      ...f.rows["warm-workspace-hit"],
      path: "/api/app/workspace/v1/agents/cold-agent/events",
      [field]: value,
    };
    assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
  });

test("a session-account read prewarms the same session profile", () => {
  const f = fixture(4);
  f.add(
    "early-account",
    "session",
    "/api/session/account",
    "GET",
    200,
    "rpc",
    8000,
    f.rows["warm-login"].issued_credential_scope,
  );
  assert.throws(
    () => inspectOutageRejections(f.evidence, f.collection),
    /cold profile.*already/u,
  );
});

test("a warm HTTP history entry cannot hide its Cookie behind a null scope", () => {
  const f = fixture(4);
  f.add(
    "early-profile",
    "session",
    "/api/session",
    "GET",
    200,
    "rpc",
    8000,
    null,
  );
  assert.throws(
    () => inspectOutageRejections(f.evidence, f.collection),
    /unauthenticated.*login/u,
  );
});

test("Bridge transport cannot be relabelled as historical revision 3", () => {
  const f = fixture();
  f.evidence.transport = "http-sse";
  assert.throws(
    () => inspectOutageRejections(f.evidence, f.collection),
    /revision 4/u,
  );
});

test("Bridge-only cold labels cannot enter a historical revision 3 report", () => {
  const f = fixture();
  f.evidence.http.push({
    ...f.rows["stopped-cold-acp"],
    label: "stopped-cold-agent",
  });
  assert.throws(
    () => inspectOutageRejections(f.evidence, f.collection),
    /revision 4/u,
  );
});

test("the same Cookie's workspace bootstrap has an independent empty Agent key", () => {
  const f = fixture(4);
  f.add(
    "early-bootstrap",
    "workspace",
    "/api/app/workspace/v1/bootstrap",
    "GET",
    200,
    "rpc",
    8000,
    f.rows["warm-login"].issued_credential_scope,
  );
  assert.equal(
    inspectOutageRejections(f.evidence, f.collection).status,
    "passed",
  );
});

for (const [name, mutate] of [
  [
    "missing marker",
    (p) => {
      p.trace.spans = p.trace.spans.filter((s) => s !== p.decision);
    },
  ],
  [
    "wrong profile",
    (p) => setTag(p.decision, resolvePrefix + "profile", "console"),
  ],
])
  test(`a protected history response cannot hide its Resolve admission: ${name}`, () => {
    const f = fixture(4);
    f.add(
      "early-agent",
      "workspace",
      "/api/app/workspace/v1/agents/cold-agent/view",
      "GET",
      200,
      "rpc",
      8000,
      f.rows["warm-login"].issued_credential_scope,
    );
    mutate(f.parts["early-agent"]);
    assert.throws(
      () => inspectOutageRejections(f.evidence, f.collection),
      /Resolve/u,
    );
  });

test("a different Cookie's earlier read does not warm the original Cookie's cold Agent", () => {
  const f = fixture(4);
  f.add(
    "other-cookie",
    "workspace",
    "/api/app/workspace/v1/agents/cold-agent/view",
    "GET",
    200,
    "rpc",
    8000,
    f.rows["audit-login"].issued_credential_scope,
  );
  assert.equal(
    inspectOutageRejections(f.evidence, f.collection).status,
    "passed",
  );
});

test("five historical outage rejections keep HTTP/cookie/scope/Trace evidence and unchanged short-idle authority", () => {
  const f = fixture();
  const before = structuredClone([...f.collection.traces]);
  const result = inspectOutageRejections(f.evidence, f.collection);
  assert.equal(result.status, "passed");
  assert.equal(result.requests.length, 5);
  assert.equal(result.expired_recovery.status, 401);
  assert.equal(result.strict_trace, "failed");
  const expected = [
    ...Object.entries(f.parts)
      .filter(([name]) => name.startsWith("stopped-"))
      .flatMap(([, p]) =>
        p.trace.spans.map((s) => ({
          trace_id: p.trace.traceID,
          span_id: s.spanID,
          reason: "outage-http-unavailable",
        })),
      ),
    ...f.parts["recovered-expired-session"].trace.spans
      .filter((s) => s.spanID !== "sql")
      .map((s) => ({
        trace_id: s.traceID,
        span_id: s.spanID,
        reason: "recovered-session-expired",
      })),
  ];
  const ordered = (rows) =>
    [...rows].sort((a, b) =>
      `${a.trace_id}:${a.span_id}`.localeCompare(`${b.trace_id}:${b.span_id}`),
    );
  assert.deepEqual(ordered(result.owned_error_spans), ordered(expected));
  assert.equal(result.owned_error_spans.length, 18);
  assert.deepEqual([...f.collection.traces], before);
});
test("process-owned Resolve cancellation can finish its real CLIENT after the HTTP deadline response", () => {
  const f = fixture();
  const part = f.parts["stopped-cold-console"];
  part.trace.spans.at(-1).duration = 100000;
  failed(
    part.root,
    "deadline_exceeded",
    "Request deadline exceeded",
    ["context.deadlineExceededError"],
    "request",
  );
  failed(
    part.trace.spans.at(-1),
    "cancelled",
    "Request was cancelled",
    ["*errors.errorString"],
    "send",
  );
  const result = inspectOutageRejections(f.evidence, f.collection);
  assert(
    result.requests.find((r) => r.label === "stopped-cold-console")
      .retained_client_after_response_us > 0,
  );
});

test("outage error claims do not absorb unrelated archived source failures", () => {
  const f = fixture();
  const source = resolutionFixture("rpc").trace;
  source.traceID = "f".repeat(32);
  for (const span of source.spans) {
    span.traceID = source.traceID;
    for (const reference of span.references) reference.traceID = source.traceID;
  }
  setTag(source.spans[0], "error", true);
  f.collection.traces.set(source.traceID, source);
  f.collection.archivedTraceIDs.add(source.traceID);
  const result = inspectOutageRejections(f.evidence, f.collection);
  assert.equal(result.owned_error_spans.length, 18);
  assert(!result.owned_error_spans.some((s) => s.trace_id === source.traceID));
});

for (const [type, message, causes] of [
  [
    "network_error",
    "Network operation failed",
    ["*net.OpError", "syscall.Errno"],
  ],
  [
    "dns_error",
    "Could not resolve the remote service",
    ["*net.OpError", "*net.DNSError"],
  ],
  [
    "deadline_exceeded",
    "Request deadline exceeded",
    ["*net.OpError", "*net.timeoutError"],
  ],
  [
    "deadline_exceeded",
    "Request deadline exceeded",
    ["*net.OpError", "*net.DNSError", "*net.timeoutError"],
  ],
])
  test(`outage claims preserve the production ${type} chain ${causes.join("/")}`, () => {
    const f = fixture(),
      part = f.parts["stopped-cold-console"];
    failed(
      part.root,
      type,
      message,
      ["*fmt.wrapError", "*url.Error", ...causes].slice(0, 4),
      "request",
    );
    failed(part.trace.spans.at(-1), type, message, causes, "send");
    assert.equal(
      inspectOutageRejections(f.evidence, f.collection).owned_error_spans
        .length,
      18,
    );
  });

test("outage claims reject a cancelled CLIENT without the original waiter deadline reason", () => {
  const f = fixture(),
    part = f.parts["stopped-cold-console"];
  failed(
    part.root,
    "deadline_exceeded",
    "Request deadline exceeded",
    ["*fmt.wrapError", "*url.Error", "context.deadlineExceededError"],
    "request",
  );
  failed(
    part.trace.spans.at(-1),
    "cancelled",
    "Request was cancelled",
    ["*errors.errorString"],
    "send",
  );
  assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
});

test("outage claims reject independently valid but mismatched root and CLIENT causes", () => {
  const f = fixture(),
    part = f.parts["stopped-cold-console"];
  failed(
    part.root,
    "deadline_exceeded",
    "Request deadline exceeded",
    ["*fmt.wrapError", "*url.Error", "context.deadlineExceededError"],
    "request",
  );
  failed(
    part.trace.spans.at(-1),
    "deadline_exceeded",
    "Request deadline exceeded",
    ["*net.OpError", "*net.timeoutError"],
    "send",
  );
  assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
});

for (const key of [
  "antnest.outcome",
  "antnest.result",
  "antnest.operation.phase",
  "antnest.cancellation.type",
])
  test(`outage claims reject unrelated ${key}`, () => {
    const f = fixture();
    setTag(f.parts["stopped-cold-console"].root, key, "other");
    assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
  });

test("outage claims reject an error event outside its request lifetime", () => {
  const f = fixture(),
    root = f.parts["stopped-cold-console"].root;
  root.logs[0].timestamp = root.startTime - 1;
  assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
});

function quantizedGoEventFixture() {
  const f = fixture(),
    part = f.parts["stopped-new-login"],
    client = part.trace.spans.find((s) => s.spanID === "resolve-client");
  // Actual CI timestamps: Jaeger exports start, duration and event separately
  // at microsecond precision; the Go transport records its event before End.
  part.root.startTime = 1791925819795427;
  part.root.duration = 2000544;
  part.root.logs[0].timestamp = 1791925821795951;
  client.startTime = 1791925819795523;
  client.duration = 2000390;
  client.logs[0].timestamp = 1791925821795914;
  const process = part.trace.processes[client.processID];
  process.tags = [{ key: "telemetry.sdk.language", value: "go" }];
  return { ...f, client, process };
}

test("outage claims admit one integer microsecond of Go event export quantization without changing raw evidence", () => {
  const f = quantizedGoEventFixture(),
    original = structuredClone([...f.collection.traces]);
  const result = inspectOutageRejections(f.evidence, f.collection);
  assert.equal(result.status, "passed");
  assert.equal(result.owned_error_spans.length, 18);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual([...f.collection.traces], original);
});

for (const [name, mutate] of [
  ["two microseconds late", (f) => f.client.logs[0].timestamp++],
  [
    "before start",
    (f) => (f.client.logs[0].timestamp = f.client.startTime - 1),
  ],
  ["fractional event", (f) => (f.client.logs[0].timestamp += 0.5)],
  ["fractional start", (f) => (f.client.startTime += 0.5)],
  ["fractional duration", (f) => (f.client.duration += 0.5)],
  ["non-Go SDK", (f) => (f.process.tags[0].value = "nodejs")],
  ["missing SDK", (f) => (f.process.tags = [])],
  ["duplicate SDK", (f) => f.process.tags.push({ ...f.process.tags[0] })],
])
  test(`outage event quantization rejects ${name}`, () => {
    const f = quantizedGoEventFixture();
    mutate(f);
    assert.throws(
      () => inspectOutageRejections(f.evidence, f.collection),
      /refusal event outside owning span/u,
    );
  });

for (const [name, mutate] of [
  [
    "wrong stage",
    (s) =>
      (s.logs[0].fields.find((v) => v.key === "antnest.error.stage").value =
        "request"),
  ],
  [
    "unrelated cause",
    (s) =>
      (s.logs[0].fields.find(
        (v) => v.key === "antnest.error.cause_types",
      ).value = '["OtherError"]'),
  ],
  ["duplicate event", (s) => s.logs.push(structuredClone(s.logs[0]))],
])
  test(`quantized Go event still rejects ${name}`, () => {
    const f = quantizedGoEventFixture();
    mutate(f.client);
    assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
  });

test("in-span finite fractional timestamps retain their existing admission without SDK provenance", () => {
  const f = fixture(),
    client = f.parts["stopped-new-login"].trace.spans.find(
      (s) => s.spanID === "resolve-client",
    );
  client.startTime += 0.5;
  client.duration += 0.5;
  client.logs[0].timestamp = client.startTime + client.duration - 0.5;
  assert.equal(
    inspectOutageRejections(f.evidence, f.collection).status,
    "passed",
  );
});

for (const [label, selection, mutate] of [
  [
    "unrelated root failure",
    "root",
    (s) => setTag(s, "error.type", "permission_denied"),
  ],
  [
    "missing root ERROR",
    "root",
    (s) => setTag(s, "otel.status_code", undefined),
  ],
  [
    "missing root description",
    "root",
    (s) => setTag(s, "otel.status_description", undefined),
  ],
  [
    "extra root exception",
    "root",
    (s) => setTag(s, "exception.type", "OtherError"),
  ],
  ["missing root event", "root", (s) => (s.logs = [])],
  [
    "duplicate root event",
    "root",
    (s) => s.logs.push(structuredClone(s.logs[0])),
  ],
  [
    "wrong root stage",
    "root",
    (s) =>
      (s.logs[0].fields.find((x) => x.key === "antnest.error.stage").value =
        "send"),
  ],
  [
    "duplicate root diagnostic field",
    "root",
    (s) => s.logs[0].fields.push({ ...s.logs[0].fields[0] }),
  ],
  ["decision without ERROR", "decision", (s) => setTag(s, "error", undefined)],
  [
    "unrelated decision exception",
    "decision",
    (s) => setTag(s, "exception.type", "OtherError"),
  ],
  [
    "extra decision event",
    "decision",
    (s) => (s.logs = [{ fields: [{ key: "event", value: "exception" }] }]),
  ],
  ["missing CLIENT event", "client", (s) => (s.logs = [])],
  [
    "wrong CLIENT stage",
    "client",
    (s) =>
      (s.logs[0].fields.find((x) => x.key === "antnest.error.stage").value =
        "read_response"),
  ],
  [
    "unrelated CLIENT cause",
    "client",
    (s) =>
      (s.logs[0].fields.find(
        (x) => x.key === "antnest.error.cause_types",
      ).value = '["*json.SyntaxError"]'),
  ],
  [
    "duplicate CLIENT error tag",
    "client",
    (s) => s.tags.push({ key: "error", value: true }),
  ],
  [
    "401 missing root ERROR",
    "recovered-root",
    (s) => setTag(s, "error", undefined),
  ],
  [
    "401 unrelated CLIENT description",
    "recovered-client",
    (s) => setTag(s, "otel.status_description", "unrelated failure"),
  ],
  [
    "401 extra CLIENT event",
    "recovered-client",
    (s) => (s.logs = [{ fields: [{ key: "event", value: "exception" }] }]),
  ],
  [
    "401 wrong decision result",
    "recovered-decision",
    (s) => setTag(s, "otel.status_description", "unavailable"),
  ],
  [
    "401 unrelated SERVER event",
    "recovered-server",
    (s) =>
      (s.logs[0].fields.find((x) => x.key === "antnest.error.code").value =
        "forbidden"),
  ],
  ["401 missing SERVER event", "recovered-server", (s) => (s.logs = [])],
  [
    "401 unrelated database failure",
    "recovered-server",
    (s) => setTag(s, "db.response.status_code", "23505"),
  ],
  [
    "401 wrong RPC method",
    "recovered-server",
    (s) => setTag(s, "rpc.method", "local_login"),
  ],
  [
    "401 successful SERVER result",
    "recovered-server",
    (s) => setTag(s, "antnest.result", "success"),
  ],
])
  test(`outage claims reject ${label}`, () => {
    const f = fixture();
    const part =
      f.parts[
        selection.startsWith("recovered-")
          ? "recovered-expired-session"
          : "stopped-cold-console"
      ];
    const role = selection.replace("recovered-", "");
    const span =
      role === "root" || role === "decision"
        ? part[role]
        : part.trace.spans.find((s) => s.spanID === `resolve-${role}`);
    mutate(span);
    assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
  });
for (const [label, mutate] of [
  [
    "stopped decision before its request",
    (f) => {
      const p = f.parts["stopped-cold-console"];
      p.decision.duration += p.decision.startTime - p.root.startTime + 1;
      p.decision.startTime = p.root.startTime - 1;
    },
  ],
  [
    "recovered CLIENT after its decision",
    (f) => {
      const p = f.parts["recovered-expired-session"];
      p.trace.spans.find((s) => s.spanID === "resolve-client").startTime =
        p.decision.startTime + p.decision.duration + 1;
    },
  ],
  [
    "recovered CLIENT before its decision",
    (f) => {
      const p = f.parts["recovered-expired-session"];
      p.trace.spans.find((s) => s.spanID === "resolve-client").startTime =
        p.decision.startTime - 1;
    },
  ],
  [
    "recovered decision after its request",
    (f) => {
      const p = f.parts["recovered-expired-session"];
      const offset = p.root.duration + 1000;
      p.decision.startTime += offset;
      p.trace.spans.find((s) => s.spanID === "resolve-client").startTime +=
        offset;
    },
  ],
  [
    "recovered 401 on another route",
    (f) => {
      f.rows["recovered-expired-session"].path = "/api/session/logout";
      setTag(
        f.parts["recovered-expired-session"].root,
        "http.route",
        "/api/session/logout",
      );
    },
  ],
  [
    "recovered 401 with another method",
    (f) => {
      f.rows["recovered-expired-session"].method = "POST";
      setTag(
        f.parts["recovered-expired-session"].root,
        "http.request.method",
        "POST",
      );
    },
  ],
  [
    "recovered 401 without response time",
    (f) => delete f.rows["recovered-expired-session"].at,
  ],
  [
    "recovered 401 before its request",
    (f) => (f.rows["recovered-expired-session"].at = 15999),
  ],
  [
    "recovered 401 with nonfinite request time",
    (f) => (f.rows["recovered-expired-session"].started_at = Infinity),
  ],
  [
    "recovered 401 with nonfinite response time",
    (f) => (f.rows["recovered-expired-session"].at = Infinity),
  ],
  [
    "503 without an actual response",
    (f) => delete f.rows["stopped-cold-console"].status,
  ],
  [
    "client timeout substituted for failure",
    (f) => {
      delete f.rows["stopped-new-login"].at;
      f.rows["stopped-new-login"].failure = "TimeoutError";
    },
  ],
  ["response after restart", (f) => (f.rows["stopped-cold-acp"].at = 15101)],
  [
    "extended stop to fit slow rejection",
    (f) => (f.rows["stopped-cold-acp"].at = 15050),
  ],
  [
    "request before stop",
    (f) => (f.rows["stopped-cold-console"].started_at = 9999),
  ],
  [
    "wrong HTTP error code",
    (f) => (f.rows["stopped-cold-console"].body.code = "forbidden"),
  ],
  [
    "missing HTTP error message",
    (f) => delete f.rows["stopped-new-login"].body.message,
  ],
  [
    "non-string HTTP error message",
    (f) => (f.rows["stopped-new-login"].body.message = 123),
  ],
  [
    "late direct login CLIENT",
    (f) => (f.parts["stopped-new-login"].trace.spans.at(-1).duration = 100000),
  ],
  [
    "late Resolve without deadline ownership",
    (f) =>
      (f.parts["stopped-cold-console"].trace.spans.at(-1).duration = 100000),
  ],
  [
    "fabricated rpc-only cancel marker",
    (f) =>
      setTag(
        f.parts["stopped-cold-console"].decision,
        resolvePrefix + "cancel_kind",
        "caller-deadline",
      ),
  ],
  [
    "unbounded stopped Identity attempt",
    (f) =>
      setTag(
        f.parts["stopped-cold-console"].trace.spans.at(-1),
        "antnest.request.timeout_ms",
        5000,
      ),
  ],
  [
    "credential cookie written",
    (f) => (f.rows["stopped-new-login"].set_cookie_count = 2),
  ],
  [
    "warm credential substituted",
    (f) =>
      (f.rows["stopped-cold-console"].credential_scope =
        f.rows["warm-login"].issued_credential_scope),
  ],
  [
    "cold scope already requested",
    (f) =>
      f.evidence.http.push({
        ...f.rows["stopped-cold-console"],
        label: "early",
        started_at: 5000,
        at: 5010,
        status: 200,
      }),
  ],
  [
    "same cold token prewarmed another route",
    (f) =>
      f.evidence.http.push({
        ...f.rows["stopped-cold-console"],
        label: "early",
        path: "/api/admin/agents",
        started_at: 5000,
        at: 5010,
        status: 200,
      }),
  ],
  [
    "short session used before fixture",
    (f) => (f.evidence.rejections.expired_session.at = 8050),
  ],
  [
    "expired cookie lost",
    (f) => (f.rows["stopped-expired-session"].credential_scope = null),
  ],
  [
    "database expiry unconfirmed",
    (f) =>
      (f.evidence.rejections.expired_session.observations[2].expired = false),
  ],
  [
    "deadline not crossed before dispatch",
    (f) => (f.evidence.rejections.expired_session.observations[2].at = 12201),
  ],
  [
    "session ordinary read renews idle",
    (f) =>
      (f.evidence.rejections.expired_session.observations[1].idle_expires_at =
        "2026-10-12T10:00:03Z"),
  ],
  [
    "short idle fixture changed absolute",
    (f) =>
      (f.evidence.rejections.expired_session.after.expires_at =
        "2026-10-12T11:00:00Z"),
  ],
  [
    "session cache exceeds idle",
    (f) =>
      setTag(
        f.parts["short-idle-hit"].decision,
        resolvePrefix + "valid_for_ms",
        9000,
      ),
  ],
  [
    "short session initial SQL failed",
    (f) =>
      setTag(
        f.parts["short-idle-warm"].trace.spans.find((s) => s.spanID === "sql"),
        "error",
        true,
      ),
  ],
  [
    "business forwarding after recovered expired rejection",
    (f) =>
      f.parts["recovered-expired-session"].trace.spans.push(
        f.parts["recovered-expired-session"].upstream,
      ),
  ],
  [
    "missing expiry SELECT",
    (f) => f.parts["recovered-expired-session"].trace.spans.pop(),
  ],
  [
    "expiry query returned a live row",
    (f) =>
      setTag(
        f.parts["recovered-expired-session"].trace.spans.at(-1),
        "pgx.rows_affected",
        1,
      ),
  ],
  [
    "unrelated rejection query",
    (f) =>
      setTag(
        f.parts["recovered-expired-session"].trace.spans.at(-1),
        "db.query.text",
        "SELECT $1",
      ),
  ],
  [
    "missing isolated no-match proof",
    (f) => delete f.evidence.rejections.expired_session.no_match_probe,
  ],
  [
    "warm session isolation missing",
    (f) => (f.evidence.rejections.expired_session.protected_unchanged = 1),
  ],
  [
    "expired session remains accepted",
    (f) => (f.rows["stopped-expired-session"].status = 200),
  ],
  [
    "recovery session accepted",
    (f) => (f.rows["recovered-expired-session"].status = 200),
  ],
  [
    "wrong server-selected profile",
    (f) =>
      setTag(
        f.parts["stopped-cold-acp"].decision,
        resolvePrefix + "profile",
        "workspace",
      ),
  ],
  [
    "missing actual Identity attempt",
    (f) => f.parts["stopped-cold-console"].trace.spans.pop(),
  ],
  [
    "cache pretending to be failed live Resolve",
    (f) =>
      setTag(
        f.parts["stopped-cold-console"].decision,
        resolvePrefix + "source",
        "cache",
      ),
  ],
  [
    "business CLIENT forwarding",
    (f) =>
      f.parts["stopped-cold-console"].trace.spans.push(
        f.parts["stopped-cold-console"].upstream,
      ),
  ],
  [
    "unknown RPC destination",
    (f) =>
      setTag(
        f.parts["stopped-cold-console"].trace.spans.at(-1),
        "server.address",
        "agent-controller",
      ),
  ],
  [
    "failed CLIENT has success status",
    (f) =>
      setTag(
        f.parts["stopped-cold-console"].trace.spans.at(-1),
        "http.response.status_code",
        200,
      ),
  ],
  [
    "missing raw archive",
    (f) =>
      f.collection.archivedTraceIDs.delete(
        f.rows["stopped-cold-console"].trace_id,
      ),
  ],
  [
    "incomplete synchronous parent",
    (f) =>
      (f.parts["stopped-new-login"].trace.spans.at(-1).references[0].spanID =
        "missing"),
  ],
])
  test(`outage rejection gate rejects ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspectOutageRejections(f.evidence, f.collection));
  });
