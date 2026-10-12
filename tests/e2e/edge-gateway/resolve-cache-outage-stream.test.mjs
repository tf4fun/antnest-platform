import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageStreams } from "./resolve-cache-outage-stream.mjs";
import {
  resolutionFixture,
  addResolveRPC,
  resolvePrefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

const epoch = 1791786600000;
const end = (s) => s.startTime + s.duration;
const operationMessage =
  "Operation failed; unclassified error text was not exported";
function fixture() {
  const traces = new Map(),
    parts = {},
    http = [];
  let next = 1;
  const stamp = (at) => ({ at, observed_at_ms: epoch + at });
  const principal = {
    user_id: "user",
    membership_id: "member",
    organization_id: "org",
  };
  const row = (label, at, rest) => {
    const r = {
      label,
      method: "GET",
      status: 200,
      set_cookie_count: 0,
      started_at: at,
      ...stamp(at + 100),
      server_date: new Date(epoch + Math.floor(at / 1000) * 1000).toUTCString(),
      ...rest,
    };
    http.push(r);
    return r;
  };
  const login = (label, at) =>
    row(label, at, {
      path: "/api/session/login",
      method: "POST",
      set_cookie_count: 2,
      issued_credential_scope: `${label}-scope`,
      body: { principal },
    });
  const prep = login("prep-login", 0),
    warm = login("warm-login", 2850);
  const e = {
    project: "project",
    agent_id: "agent",
    session_id: "warm-session",
    settings: { resolveTTLMS: 10000, captureRpcContent: false },
    http,
    recovery: { cases: [] },
    identity: { healthy: { at: 11000 } },
  };
  const state = (service, start, finish, at, running = true) => ({
    id: service + "-id",
    project: e.project,
    service,
    running,
    restarting: false,
    oom_killed: false,
    exit_code: 0,
    started_at: new Date(epoch + start).toISOString(),
    finished_at: new Date(epoch + finish).toISOString(),
    health: running ? "healthy" : "unhealthy",
    ...stamp(at),
  });
  e.consumer_restarts = [
    {
      service: "agent-acp-service",
      before: state("agent-acp-service", -10000, -20000, 1800),
      started_at: 1801,
      after: state("agent-acp-service", 2000, 1900, 2200),
    },
    {
      service: "agent-ui",
      before: state("agent-ui", -10000, -20000, 2500),
      started_at: 2501,
      after: state("agent-ui", 2700, 2600, 2800),
    },
  ];
  e.ui_drain = {
    before: state("agent-ui", 2700, 2600, 28000),
    started_at: 28001,
    after: state("agent-ui", 2700, 28500, 28600, false),
  };
  const event = (s, values) => {
    s.logs = [
      {
        timestamp: end(s) - 1,
        fields: fields({ event: "antnest.error", ...values }),
      },
    ];
  };
  const fault = (s, tags, values) => {
    for (const [k, v] of Object.entries({
      error: true,
      "otel.status_code": "ERROR",
      ...tags,
    }))
      setTag(s, k, v);
    if (values) event(s, values);
    else s.logs = [];
  };
  const viewPath = (session) =>
    `/api/app/workspace/v1/agents/agent/sessions/${session}/view`;
  const make = (name, at, closed, scope, session, stream = false) => {
    const f = resolutionFixture("rpc"),
      id = (next++).toString(16).padStart(32, "0");
    f.trace.traceID = id;
    const offset = (epoch + at + 5) * 1000 - f.root.startTime;
    for (const s of f.trace.spans) {
      s.traceID = id;
      s.startTime += offset;
      s.logs = [];
      for (const ref of s.references) ref.traceID = id;
    }
    f.root.operationName = "HTTP GET /api/app/workspace/v1/{path...}";
    setTag(f.root, "http.route", "/api/app/workspace/v1/{path...}");
    f.root.duration = (epoch + closed) * 1000 - f.root.startTime;
    f.upstream.operationName = "HTTP GET agent-ui";
    setTag(f.upstream, "http.response.status_code", 200);
    setTag(f.upstream, "server.address", "agent-ui");
    f.upstream.duration = end(f.root) - f.upstream.startTime - 100;
    f.trace.processes.ui = { serviceName: "agent-ui" };
    f.trace.processes.acp = { serviceName: "agent-acp-service" };
    f.ui = {
      ...structuredClone(f.upstream),
      spanID: "ui",
      processID: "ui",
      operationName: "agent_ui.http.request",
      startTime: f.upstream.startTime + 1000,
      duration: f.upstream.duration - 2000,
      references: [
        { refType: "CHILD_OF", traceID: id, spanID: f.upstream.spanID },
      ],
      tags: fields({
        "span.kind": "server",
        "http.request.method": "GET",
        "http.response.status_code": 200,
        "http.route": "/api/app/workspace/v1/*",
      }),
    };
    f.trace.spans.push(f.ui);
    f.watches = [];
    f.watch = (marker = false, finish = 28490) => {
      const s = {
        ...structuredClone(f.ui),
        spanID: `watch-${f.watches.length}`,
        processID: "acp",
        operationName: marker
          ? "HTTP POST /rpc/agent-acp/watch-agent-execution-state"
          : "HTTP GET /v1/acp",
        startTime: f.ui.startTime + 2000,
        duration: (epoch + finish) * 1000 - f.ui.startTime - 2000,
        references: [{ refType: "CHILD_OF", traceID: id, spanID: f.ui.spanID }],
        tags: fields({
          "span.kind": "server",
          "http.request.method": marker ? "POST" : "GET",
          "http.response.status_code": 200,
          "http.route": marker
            ? "/rpc/agent-acp/watch-agent-execution-state"
            : "/v1/acp",
        }),
      };
      fault(
        s,
        marker
          ? {
              "error.type": "Error",
              "antnest.outcome": "error",
              "antnest.operation.phase": "agent.execution_state",
              "antnest.stream.termination": "process-shutdown",
              "rpc.method": "watch_agent_execution_state",
              "rpc.service": "agent-acp",
              "rpc.system.name": "json-over-http",
            }
          : {
              "error.type": "stream_interrupted",
              "antnest.outcome": "disconnected",
            },
        marker
          ? {
              "antnest.error.cause_types": "[]",
              "antnest.error.causes":
                '[{"type":"Error","message":"Error: unregistered message omitted"}]',
              "antnest.error.message": "Error: unregistered message omitted",
              "antnest.error.stage": "agent.execution_state",
              "antnest.error.type": "Error",
              "antnest.operation.phase": "agent.execution_state",
            }
          : null,
      );
      f.watches.push(s);
      f.trace.spans.push(s);
      return s;
    };
    if (stream) {
      fault(
        f.root,
        { "otel.status_description": "handler_aborted" },
        {
          "antnest.error.panic_type": "*errors.errorString",
          "antnest.error.stage": "handler",
          "error.type": "handler_aborted",
        },
      );
      fault(
        f.upstream,
        {
          "error.type": "operation_failed",
          "otel.status_description": operationMessage,
        },
        {
          "antnest.error.cause_types": '["*errors.errorString"]',
          "antnest.error.message": operationMessage,
          "antnest.error.stage": "read_response",
          "error.type": "operation_failed",
        },
      );
      f.row = {
        trace_id: id,
        path: `/api/app/workspace/v1/agents/agent/events?sessionId=${session}`,
        credential_scope: scope,
        status: 200,
        set_cookie_count: 0,
        started_at: at,
        headers_at: at + 50,
        server_date: new Date(
          epoch + Math.floor(at / 1000) * 1000,
        ).toUTCString(),
        closure: { kind: "transport-end", trace_id: id, ...stamp(closed + 2) },
      };
    } else
      f.row = row(name, at, {
        trace_id: id,
        path: viewPath(session),
        credential_scope: scope,
      });
    parts[name] = f;
    traces.set(id, f.trace);
    return f;
  };
  const pre = make(
    "prep-view",
    1000,
    1100,
    prep.issued_credential_scope,
    e.session_id,
  );
  pre.watch(false, 1890);
  pre.watch(false, 1891);
  pre.marker = pre.watch(true, 1889);
  setTag(pre.marker, "antnest.agent.id", e.agent_id);
  setTag(pre.marker, "antnest.organization.id", principal.organization_id);
  const warmView = make(
    "warm-workspace-view",
    3000,
    3100,
    warm.issued_credential_scope,
    e.session_id,
  );
  warmView.watch();
  warmView.watch();
  make(
    "recovered-workspace-view",
    11500,
    11600,
    warm.issued_credential_scope,
    e.session_id,
  );
  const warmSSE = make(
    "warm-stream",
    3200,
    17500,
    warm.issued_credential_scope,
    e.session_id,
    true,
  );
  e.stream = warmSSE.row;
  const again = structuredClone(warmSSE.decision);
  again.spanID = "revalidation";
  again.startTime = (epoch + 13200) * 1000;
  warmSSE.trace.spans.push(again);
  addResolveRPC(warmSSE.trace, "-later", again.startTime + 1000);
  for (const [i, name] of [
    "logout",
    "password",
    "role",
    "deactivate",
  ].entries()) {
    const at = 12000 + i * 4000,
      session = name + "-session",
      l = login(`recovery-${name}-login`, at - 200);
    const view = make(
      name + "-view",
      at,
      at + 100,
      l.issued_credential_scope,
      session,
    );
    view.watch();
    const sse = make(
      name + "-stream",
      at + 200,
      at + 1500,
      l.issued_credential_scope,
      session,
      true,
    );
    const mutation = row(name + "-mutation", at + 1000, {
      path:
        name === "logout"
          ? "/api/session"
          : name === "password"
            ? "/api/session/password"
            : "/api/admin/directory/memberships/member",
      method: name === "logout" ? "DELETE" : "POST",
      status: name === "logout" ? 204 : 200,
      credential_scope: l.issued_credential_scope,
    });
    e.recovery.cases.push({
      name,
      session_id: session,
      login: l,
      initial_view: view.row,
      stream: sse.row,
      mutation,
      trigger: stamp(at + 1000),
    });
  }
  // An unrelated raw error must survive without being claimed by this gate.
  const unrelated = resolutionFixture("cache");
  unrelated.trace.traceID = "f".repeat(32);
  for (const s of unrelated.trace.spans) {
    s.traceID = unrelated.trace.traceID;
    for (const r of s.references) r.traceID = s.traceID;
  }
  setTag(unrelated.root, "error", true);
  unrelated.trace.warnings = ["raw warning"];
  traces.set(unrelated.trace.traceID, unrelated.trace);
  return {
    evidence: e,
    traces,
    archivedTraceIDs: new Set(traces.keys()),
    parts,
  };
}
const check = (f, secrets = [], options) =>
  inspectOutageStreams(f.evidence, f, secrets, options);
test("stream claims bind five remote retirements and actual retained internal watches without changing raw errors", () => {
  const f = fixture(),
    before = structuredClone(f.traces),
    result = check(f);
  assert.equal(result.status, "passed");
  assert.equal(result.streams.length, 5);
  assert.equal(result.internal_watches.length, 9);
  assert.equal(result.owned_error_spans.length, 19);
  assert.equal(
    new Set(result.owned_error_spans.map((s) => `${s.trace_id}:${s.span_id}`))
      .size,
    19,
  );
  assert.equal(result.error_spans, 20);
  assert.equal(result.warning_count, 1);
  assert.equal(result.strict_trace, "failed");
  assert(!result.owned_error_spans.some((s) => s.trace_id === "f".repeat(32)));
  assert.deepEqual(f.traces, before);
  assert.equal(result.streams[0].gateway_revalidations.length, 1);
});
test("view connection reuse does not require a fixed per-view number of watches", () => {
  const f = fixture(),
    from = f.parts["warm-workspace-view"],
    to = f.parts["recovered-workspace-view"];
  const s = from.watches.pop();
  from.trace.spans.splice(from.trace.spans.indexOf(s), 1);
  const n = to.watch();
  n.duration = end(s) - n.startTime;
  assert.equal(check(f).owned_error_spans.length, 19);
});
test("remote clean EOF is also an independent retirement observation", () => {
  const f = fixture();
  f.evidence.stream.closure.kind = "remote-end";
  assert.equal(check(f).status, "passed");
});

for (const [name, change] of [
  ["local SSE close", (f) => (f.evidence.stream.closure.kind = "local-close")],
  ["aborted SSE", (f) => (f.evidence.stream.closure.kind = "aborted")],
  ["invalid SSE", (f) => (f.evidence.stream.closure.kind = "invalid-event")],
  [
    "foreign closure Trace",
    (f) => (f.evidence.stream.closure.trace_id = "e".repeat(32)),
  ],
  ["wrong SSE Session", (f) => (f.evidence.stream.path += "other")],
  ["wrong SSE scope", (f) => (f.evidence.stream.credential_scope = "other")],
  ["SSE Cookie mutation", (f) => (f.evidence.stream.set_cookie_count = 1)],
  ["SSE admission failure", (f) => (f.evidence.stream.status = 503)],
  ["missing HTTP Date", (f) => delete f.evidence.stream.server_date],
  ["headers before request", (f) => (f.evidence.stream.headers_at = 0)],
  ["closure before password", (f) => (f.evidence.stream.closure.at = 16000)],
  ["closure after bound", (f) => (f.evidence.stream.closure.at = 48001)],
  [
    "different password member",
    (f) =>
      (f.evidence.recovery.cases[1].login.body = {
        principal: { user_id: "other" },
      }),
  ],
  [
    "wrong password mutation",
    (f) => (f.evidence.recovery.cases[1].mutation.path = "/api/session"),
  ],
  ["missing recovery case", (f) => f.evidence.recovery.cases.pop()],
  [
    "missing original view response",
    (f) =>
      (f.evidence.http = f.evidence.http.filter(
        (r) => r !== f.evidence.recovery.cases[0].initial_view,
      )),
  ],
  [
    "view from other scope",
    (f) =>
      (f.evidence.recovery.cases[0].initial_view.credential_scope = "other"),
  ],
  [
    "view for other Session",
    (f) => (f.evidence.recovery.cases[0].initial_view.path += "other"),
  ],
  [
    "missing stream archive",
    (f) => f.archivedTraceIDs.delete(f.evidence.stream.trace_id),
  ],
  [
    "missing view archive",
    (f) => f.archivedTraceIDs.delete(f.parts["prep-view"].trace.traceID),
  ],
  [
    "missing parent",
    (f) => (f.parts["warm-stream"].ui.references[0].spanID = "missing"),
  ],
  [
    "wrong forwarding parent",
    (f) => (f.parts["warm-stream"].upstream.references[0].spanID = "decision"),
  ],
  [
    "wrong receiver service",
    (f) => (f.parts["warm-stream"].trace.processes.ui.serviceName = "other"),
  ],
  [
    "wrong receiver route",
    (f) => setTag(f.parts["warm-stream"].ui, "http.route", "/other"),
  ],
  [
    "wrong forwarding operation",
    (f) =>
      (f.parts["warm-stream"].upstream.operationName = "HTTP POST agent-ui"),
  ],
  [
    "wrong root response",
    (f) =>
      setTag(f.parts["warm-stream"].root, "http.response.status_code", 503),
  ],
  [
    "root closed before mutation",
    (f) => (f.parts["warm-stream"].root.duration = 1000000),
  ],
  ["late root close", (f) => (f.parts["warm-stream"].root.duration += 5000000)],
  [
    "failed revalidation",
    (f) =>
      setTag(
        f.parts["warm-stream"].trace.spans.find(
          (s) => s.spanID === "revalidation",
        ),
        resolvePrefix + "outcome",
        "unavailable",
      ),
  ],
  [
    "wrong revalidation receipt",
    (f) =>
      setTag(
        f.parts["warm-stream"].trace.spans.find(
          (s) => s.spanID === "resolve-server-later",
        ),
        "http.response.status_code",
        401,
      ),
  ],
  [
    "unclaimed SQL diagnostic",
    (f) =>
      setTag(
        f.parts["warm-stream"].trace.spans.find((s) => s.spanID === "sql"),
        "db.response.status_code",
        "ERROR",
      ),
  ],
  [
    "extra receiver error",
    (f) => setTag(f.parts["warm-stream"].ui, "error.type", "database_error"),
  ],
  [
    "wrong root error type",
    (f) => setTag(f.parts["warm-stream"].root, "error.type", "panic"),
  ],
  [
    "wrong forwarding cause",
    (f) =>
      (f.parts["warm-stream"].upstream.logs[0].fields.find(
        (v) => v.key === "antnest.error.cause_types",
      ).value = '["*net.OpError"]'),
  ],
  ["missing root event", (f) => (f.parts["warm-stream"].root.logs = [])],
  [
    "extra forwarding event",
    (f) =>
      f.parts["warm-stream"].upstream.logs.push(
        structuredClone(f.parts["warm-stream"].upstream.logs[0]),
      ),
  ],
  [
    "error event outside span",
    (f) =>
      (f.parts["warm-stream"].root.logs[0].timestamp =
        end(f.parts["warm-stream"].root) + 1),
  ],
  [
    "duplicate error field",
    (f) => f.parts["warm-stream"].root.tags.push({ key: "error", value: true }),
  ],
  [
    "replacement ACP container",
    (f) => (f.evidence.consumer_restarts[0].after.id = "replacement"),
  ],
  [
    "abnormal ACP exit",
    (f) => (f.evidence.consumer_restarts[0].after.exit_code = 1),
  ],
  ["ACP OOM", (f) => (f.evidence.consumer_restarts[0].after.oom_killed = true)],
  [
    "ACP did not restart",
    (f) =>
      (f.evidence.consumer_restarts[0].after.started_at =
        f.evidence.consumer_restarts[0].before.started_at),
  ],
  [
    "different UI at final drain",
    (f) => (f.evidence.ui_drain.before.id = "different"),
  ],
  [
    "different UI process at drain",
    (f) =>
      (f.evidence.ui_drain.before.started_at = new Date(
        epoch + 9000,
      ).toISOString()),
  ],
  ["UI still running", (f) => (f.evidence.ui_drain.after.running = true)],
  ["abnormal UI exit", (f) => (f.evidence.ui_drain.after.exit_code = 137)],
  [
    "drain before public closure",
    (f) => (f.evidence.ui_drain.started_at = 25000),
  ],
  [
    "foreign ACP watch parent",
    (f) => (f.parts["prep-view"].watches[0].references[0].spanID = "root"),
  ],
  [
    "wrong ACP watch method",
    (f) =>
      setTag(f.parts["prep-view"].watches[0], "http.request.method", "POST"),
  ],
  [
    "ACP watch non-200",
    (f) =>
      setTag(f.parts["prep-view"].watches[0], "http.response.status_code", 503),
  ],
  [
    "disconnect before restart",
    (f) => (f.parts["prep-view"].watches[0].duration = 100),
  ],
  [
    "disconnect after process finish",
    (f) => (f.parts["prep-view"].watches[0].duration += 1000000),
  ],
  [
    "missing shutdown marker",
    (f) =>
      setTag(
        f.parts["prep-view"].marker,
        "antnest.stream.termination",
        undefined,
      ),
  ],
  [
    "wrong marked RPC",
    (f) => setTag(f.parts["prep-view"].marker, "rpc.method", "other"),
  ],
  [
    "wrong shutdown phase",
    (f) =>
      setTag(
        f.parts["prep-view"].marker,
        "antnest.operation.phase",
        "delivery",
      ),
  ],
  [
    "generic shutdown cause",
    (f) =>
      (f.parts["prep-view"].marker.logs[0].fields.find(
        (v) => v.key === "antnest.error.causes",
      ).value = "[]"),
  ],
  [
    "extra shutdown diagnostic",
    (f) => setTag(f.parts["prep-view"].marker, "exception.type", "other"),
  ],
  [
    "extra disconnect log",
    (f) =>
      (f.parts["prep-view"].watches[0].logs = [
        {
          fields: fields({ event: "antnest.error" }),
          timestamp: end(f.parts["prep-view"].watches[0]),
        },
      ]),
  ],
  [
    "unbound extra view failure",
    (f) => setTag(f.parts["recovered-workspace-view"].ui, "error", true),
  ],
  [
    "unfinished internal watch",
    (f) => (f.parts["prep-view"].watches[0].duration = NaN),
  ],
])
  test(`stream ownership rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  });
test("stream raw closure remains secret-free", () => {
  const f = fixture();
  setTag(f.parts["prep-view"].ui, "unexpected", "secret-canary");
  assert.throws(() => check(f, ["secret-canary"]));
});

function benignTelemetry(f, kind) {
  const p = f.parts["prep-view"],
    s = structuredClone(p.ui);
  s.spanID = "benign";
  s.logs = [];
  s.references = [
    { refType: "CHILD_OF", traceID: p.trace.traceID, spanID: p.ui.spanID },
  ];
  if (kind === "cancelled-read") {
    s.processID = "acp";
    s.operationName = "HTTP POST antnest-runtime";
    s.tags = fields({
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "peer.service": "antnest-runtime",
      "antnest.operation.phase": "http.send_or_read",
      "antnest.outcome": "cancelled",
      "antnest.cancellation.type": "AbortError",
    });
    s.logs = [
      {
        timestamp: end(s) - 1,
        fields: fields({
          event: "antnest.cancelled",
          "antnest.cancellation.phase": "http.send_or_read",
          "antnest.cancellation.type": "AbortError",
        }),
      },
    ];
  } else {
    p.trace.processes.runtime = { serviceName: "antnest-runtime" };
    s.processID = "runtime";
    s.operationName = "runtime.mcp.operation";
    s.tags = fields({
      "span.kind": "internal",
      "antnest.operation.outcome": "success",
      "mcp.operation.outcome": "success",
      "error.type": "",
      "otel.status_code": "OK",
    });
    s.logs = [
      {
        timestamp: end(s),
        fields: fields({
          event: "Runtime MCP operation completed",
          "error.type": "",
          "mcp.operation.outcome": "success",
        }),
      },
    ];
  }
  p.trace.spans.push(s);
  return s;
}
for (const kind of ["cancelled-read", "successful-runtime"]) {
  test(`retained non-error ${kind} telemetry is not an error claim`, () => {
    const f = fixture();
    benignTelemetry(f, kind);
    const r = check(f);
    assert.equal(r.error_spans, 20);
    assert.equal(r.owned_error_spans.length, 19);
  });
  test(`non-error ${kind} cannot carry another exception`, () => {
    const f = fixture();
    setTag(benignTelemetry(f, kind), "exception.type", "storage_error");
    assert.throws(() => check(f));
  });
}
test("long warm SSE requires its actual successful revalidation", () => {
  const f = fixture(),
    t = f.parts["warm-stream"].trace;
  t.spans = t.spans.filter(
    (s) => s.spanID !== "revalidation" && !s.spanID.endsWith("-later"),
  );
  assert.throws(() => check(f));
});
test("self mutation must use the original recovery credential", () => {
  const f = fixture();
  f.evidence.recovery.cases[1].mutation.credential_scope = "other";
  assert.throws(() => check(f));
});
for (const key of ["antnest.agent.id", "antnest.organization.id"])
  test(`marked shutdown belongs to the actual ${key}`, () => {
    const f = fixture();
    setTag(f.parts["prep-view"].marker, key, "foreign");
    assert.throws(() => check(f));
  });
test("empty error type is neutral on existing successful Runtime HTTP telemetry", () => {
  const f = fixture(),
    s = benignTelemetry(f, "successful-runtime");
  s.operationName = "HTTP POST /mcp";
  setTag(s, "span.kind", "server");
  setTag(s, "otel.status_code", undefined);
  s.logs[0].fields.find((v) => v.key === "event").value =
    "Runtime HTTP request completed";
  assert.equal(check(f).owned_error_spans.length, 19);
});
for (const key of [
  "mcp.operation.outcome",
  "antnest.operation.outcome",
  "antnest.protocol.outcome",
  "http.transport.outcome",
  "executor.outcome",
])
  for (const where of ["span", "event"])
    test(`empty error type cannot hide failed ${where} ${key}`, () => {
      const f = fixture(),
        s = benignTelemetry(f, "successful-runtime");
      if (where === "span") setTag(s, key, "error");
      else {
        s.logs[0].fields = s.logs[0].fields.filter((v) => v.key !== key);
        s.logs[0].fields.push({ key, value: "error" });
      }
      assert.throws(() => check(f));
    });

for (const kind of ["claimed-error", "cancelled-read"])
  test(`exact ${kind} diagnostics reject an additional failed outcome`, () => {
    const f = fixture();
    const s =
      kind === "claimed-error"
        ? f.parts["warm-stream"].root
        : benignTelemetry(f, kind);
    setTag(s, "http.transport.outcome", "error");
    assert.throws(() => check(f));
  });

function offboardingFixture(source = "session-output") {
  const f = fixture(),
    c = f.evidence.recovery.cases[3],
    traceID = "b".repeat(32);
  c.mutation.trace_id = traceID;
  c.mutation.body = {
    membership: { id: "member", user_id: "user", role: "admin", active: false },
  };
  c.disabled_agent = {
    label: "disabled-agent",
    trace_id: "c".repeat(32),
    path: "/api/admin/agents/agent",
    method: "GET",
    status: 200,
    started_at: 26500,
    at: 26600,
    body: {
      agent_id: "agent",
      owner_user_id: "user",
      desired_state: "disabled",
      lifecycle_state: "created",
      activation_state: "disabled",
      runtime_state: "absent",
    },
  };
  f.evidence.http.push(c.disabled_agent);
  const server = {
    traceID,
    spanID: "identity-offboarding",
    processID: "identity",
    operationName: "HTTP POST /rpc/identity/update-membership",
    startTime: (epoch + 25010) * 1000,
    duration: 50000,
    references: [],
    logs: [],
    tags: fields({
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/rpc/identity/update-membership",
      "http.response.status_code": 200,
      "rpc.method": "update_membership",
    }),
  };
  const transaction = {
    ...structuredClone(server),
    spanID: "offboarding-transaction",
    operationName: "postgresql transaction",
    startTime: server.startTime + 1000,
    duration: 40000,
    references: [{ refType: "CHILD_OF", traceID, spanID: server.spanID }],
    tags: fields({
      "span.kind": "internal",
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    }),
  };
  f.traces.set(traceID, {
    traceID,
    processes: { identity: { serviceName: "identity-service" } },
    spans: [server, transaction],
  });
  f.archivedTraceIDs.add(traceID);
  f.proof = {
    status: "passed",
    mutations: [
      {
        action: "deactivate",
        trace_id: traceID,
        identity_server_span_id: server.spanID,
        transaction_span_id: transaction.spanID,
      },
    ],
  };
  f.proofCalls = 0;
  // Isolate the stream consumer from the independently tested full recovery
  // inspector. The default-path test below requires that real inspector.
  f.options = {
    inspectRecovery(evidence, collection, secrets) {
      assert.equal(evidence, f.evidence);
      assert.equal(collection, f);
      assert.deepEqual(secrets, ["private-canary"]);
      f.proofCalls++;
      return f.proof;
    },
  };
  f.mark = (s, finish = 26000) => {
    s.duration = (epoch + finish) * 1000 - s.startTime;
    s.logs = [
      {
        timestamp: end(s) - 1,
        fields: fields({
          event: "antnest.stream.termination",
          reason: "access_denied",
          "error.type": "DomainError",
          source,
          "antnest.agent.id": "agent",
          "antnest.organization.id": "org",
        }),
      },
    ];
  };
  f.close = f.parts["warm-workspace-view"].watches[0];
  f.mark(f.close);
  f.transaction = transaction;
  return f;
}
const checkOffboarding = (f) => check(f, ["private-canary"], f.options);
for (const source of ["session-output", "learning-notice", "permission"])
  test(`offboarding ${source} close requires original cause and actual recovery proof`, () => {
    const f = offboardingFixture(source),
      before = structuredClone({ evidence: f.evidence, traces: f.traces }),
      result = checkOffboarding(f);
    assert.equal(result.status, "passed");
    assert.equal(result.owned_error_spans.length, 19);
    assert.equal(result.error_spans, 20);
    assert.equal(result.strict_trace, "failed");
    assert.equal(f.proofCalls, 1);
    assert.deepEqual(
      result.internal_watches.find(
        (s) => s.trace_id === f.close.traceID && s.span_id === f.close.spanID,
      ),
      {
        trace_id: f.close.traceID,
        span_id: f.close.spanID,
        reason: "internal-offboarding-access-denied",
      },
    );
    assert.deepEqual({ evidence: f.evidence, traces: f.traces }, before);
  });
test("all retained watches may close on proved offboarding before the final UI drain", () => {
  const f = offboardingFixture();
  for (const [name, p] of Object.entries(f.parts))
    if (name !== "prep-view") for (const s of p.watches) f.mark(s);
  const result = checkOffboarding(f);
  assert.equal(
    result.internal_watches.filter(
      (s) => s.reason === "internal-offboarding-access-denied",
    ).length,
    6,
  );
  assert(
    !result.internal_watches.some(
      (s) => s.reason === "internal-ui-drain-disconnect",
    ),
  );
  assert.equal(f.proofCalls, 1);
});
test("production default rejects incomplete real offboarding evidence", () => {
  const f = offboardingFixture();
  // The isolated fixture lacks full recovery RPC/SQL/business observations.
  // Its marker alone must never admit the close via the production entry point.
  assert.throws(() => check(f));
});
const eventValue = (f, key, value) => {
  f.close.logs[0].fields.find((r) => r.key === key).value = value;
};
for (const [name, change] of [
  [
    "missing original marker",
    (f) => {
      f.close.logs = [];
    },
  ],
  ["foreign Agent", (f) => eventValue(f, "antnest.agent.id", "other")],
  [
    "foreign organization",
    (f) => eventValue(f, "antnest.organization.id", "other"),
  ],
  ["generic error", (f) => eventValue(f, "error.type", "Error")],
  ["unknown close source", (f) => eventValue(f, "source", "unknown")],
  [
    "different close reason",
    (f) => eventValue(f, "reason", "connection_closed"),
  ],
  [
    "duplicate marker",
    (f) => f.close.logs.push(structuredClone(f.close.logs[0])),
  ],
  [
    "extra marker field",
    (f) =>
      f.close.logs[0].fields.push({ key: "message", value: "private-canary" }),
  ],
  [
    "duplicate marker field",
    (f) =>
      f.close.logs[0].fields.push({ key: "reason", value: "access_denied" }),
  ],
  [
    "late marker",
    (f) => {
      f.close.logs[0].timestamp = end(f.close) + 1;
    },
  ],
  ["close before actual mutation", (f) => f.mark(f.close, 24000)],
  [
    "marker before actual mutation",
    (f) => {
      f.close.logs[0].timestamp = (epoch + 24000) * 1000;
    },
  ],
  ["close after UI termination", (f) => f.mark(f.close, 29000)],
  ["preparation close", (f) => f.mark(f.parts["prep-view"].watches[0], 1890)],
  [
    "unproved recovery",
    (f) => {
      f.proof.status = "pending";
    },
  ],
  [
    "missing mutation proof",
    (f) => {
      f.proof.mutations = [];
    },
  ],
  [
    "foreign mutation proof",
    (f) => {
      f.proof.mutations[0].trace_id = "e".repeat(32);
    },
  ],
  [
    "missing mutation archive",
    (f) => f.archivedTraceIDs.delete(f.proof.mutations[0].trace_id),
  ],
  [
    "missing actual transaction",
    (f) => {
      f.proof.mutations[0].transaction_span_id = "missing";
    },
  ],
  [
    "uncommitted transaction",
    (f) => setTag(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "different view principal",
    (f) => {
      f.evidence.recovery.cases[0].login.body = {
        principal: {
          user_id: "other",
          membership_id: "member",
          organization_id: "org",
        },
      };
      f.mark(f.parts["logout-view"].watches[0]);
    },
  ],
  [
    "missing actual disabled readback",
    (f) => {
      f.evidence.http = f.evidence.http.filter(
        (r) => r !== f.evidence.recovery.cases[3].disabled_agent,
      );
    },
  ],
  [
    "foreign disabled Agent",
    (f) => {
      f.evidence.recovery.cases[3].disabled_agent.body.agent_id = "other";
    },
  ],
  [
    "foreign Agent owner",
    (f) => {
      f.evidence.recovery.cases[3].disabled_agent.body.owner_user_id = "other";
    },
  ],
  [
    "Agent still enabled",
    (f) => {
      f.evidence.recovery.cases[3].disabled_agent.body.activation_state =
        "active";
    },
  ],
  [
    "failed disabled readback",
    (f) => {
      f.evidence.recovery.cases[3].disabled_agent.status = 503;
    },
  ],
  [
    "disabled readback before mutation",
    (f) => {
      f.evidence.recovery.cases[3].disabled_agent.started_at = 24000;
    },
  ],
])
  test(`offboarding stream rejects ${name}`, () => {
    const f = offboardingFixture();
    change(f);
    assert.throws(() => checkOffboarding(f));
  });
