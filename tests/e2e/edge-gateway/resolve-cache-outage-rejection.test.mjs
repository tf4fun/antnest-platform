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

function fixture() {
  const traces = new Map(),
    rows = {},
    parts = {};
  const scope = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const evidence = {
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
    [
      "stopped-cold-acp",
      "acp",
      "/api/app/agents/agent/v1/acp",
      "POST",
      2,
      10100,
    ],
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
  return {
    evidence,
    collection: { traces, archivedTraceIDs: new Set(traces.keys()) },
    rows,
    parts,
  };
}

test("five real outage rejections keep HTTP/cookie/scope/Trace evidence and unchanged short-idle authority", () => {
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
