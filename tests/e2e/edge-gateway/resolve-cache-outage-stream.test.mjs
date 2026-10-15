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

import { addCompletedRead } from "./resolve-cache-completed-read-fixtures.mjs";
import { recoveryHTTPFixture } from "./resolve-cache-recovery-http-fixtures.mjs";
import { inspectRecoveryHTTP } from "./resolve-cache-recovery-http.mjs";
import { tag } from "../observability/trace-tree.mjs";
import {
  outageClockFixture,
  syncOutageClockSearch,
} from "./resolve-cache-outage-clock-fixtures.mjs";

const epoch = 1791786600000;
const end = (s) => s.startTime + s.duration;
const operationMessage =
  "Operation failed; unclassified error text was not exported";
const closePrefix = "antnest.ui.acp.close.";
const completeCloseReceipt = {
  target_observed: true,
  delete_attempts: 1,
  delete_responses: 1,
  delete_completed: 1,
  delete_status: 202,
  pending_requests: 0,
  stream_joined: true,
  failures: 0,
  diagnostics_truncated: false,
};
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
    f.trace.processes.ui = {
      serviceName: "agent-ui",
      tags: fields({ "host.name": "ui-container", "process.pid": 1 }),
    };
    f.trace.processes.acp = {
      serviceName: "agent-acp-service",
      tags: fields({
        "host.name": "acp-container",
        "process.pid": 1,
        "service.instance.id": "acp-container:1",
      }),
    };
    f.ui = {
      ...structuredClone(f.upstream),
      spanID: "f".repeat(16),
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
          "antnest.listener": "workspace",
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
        body: {
          agentId: e.agent_id,
          sessionId: session,
          bridgeEpoch: at < 2500 ? "old-ui-epoch" : "new-ui-epoch",
        },
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
  const result = {
    evidence: e,
    traces,
    archivedTraceIDs: new Set(traces.keys()),
    parts,
    make,
  };
  const closes = [];
  for (const [index, origin] of [pre, warmView].entries()) {
    const init = {
      ...structuredClone(origin.ui),
      processID: "acp",
      spanID: "a".repeat(16),
      operationName: "HTTP POST /v1/acp",
      startTime: origin.ui.startTime + 1000,
      duration: 500,
      references: [
        {
          refType: "CHILD_OF",
          traceID: origin.trace.traceID,
          spanID: origin.ui.spanID,
        },
      ],
      tags: fields({
        "span.kind": "server",
        "http.request.method": "POST",
        "http.route": "/v1/acp",
        "http.response.status_code": 200,
        "rpc.method": "initialize",
        "rpc.service": "acp",
        "rpc.system.name": "jsonrpc",
        "antnest.listener": "workspace",
        "antnest.agent.id": e.agent_id,
      }),
      logs: [],
    };
    origin.trace.spans.push(init);
    origin.initialize = init;
    const traceID = "d".repeat(31) + (index + 1),
      close = {
        ...structuredClone(origin.ui),
        traceID,
        spanID: "b".repeat(16),
        operationName: "agent_ui.acp.close",
        startTime: (epoch + (index === 0 ? 1895 : 28495)) * 1000,
        duration: 1000,
        tags: fields({
          "span.kind": "internal",
          "antnest.ui.acp.close.trigger": "requested",
          "antnest.ui.acp.close.outcome": "closed",
          ...Object.fromEntries(
            Object.entries(completeCloseReceipt).map(([k, v]) => [
              closePrefix + k,
              v,
            ]),
          ),
        }),
        logs: [],
        references: [
          {
            refType: "FOLLOWS_FROM",
            traceID: origin.trace.traceID,
            spanID: origin.ui.spanID,
          },
        ],
      },
      deletion = {
        ...structuredClone(close),
        spanID: "c".repeat(16),
        processID: "acp",
        operationName: "HTTP DELETE /v1/acp",
        tags: fields({
          "span.kind": "server",
          "http.request.method": "DELETE",
          "http.route": "/v1/acp",
          "http.response.status_code": 202,
          "antnest.listener": "workspace",
        }),
        references: [{ refType: "CHILD_OF", traceID, spanID: close.spanID }],
      },
      trace = {
        traceID,
        processes: {
          ui: structuredClone(origin.trace.processes.ui),
          acp: structuredClone(origin.trace.processes.acp),
        },
        spans: [close, deletion],
      };
    closes.push(trace);
    traces.set(traceID, trace);
    result.archivedTraceIDs.add(traceID);
  }
  const successfulWatch = structuredClone(pre.marker);
  successfulWatch.traceID = warmView.trace.traceID;
  successfulWatch.spanID = "successful-watch";
  successfulWatch.startTime = warmView.ui.startTime + 2000;
  successfulWatch.duration = (epoch + 28489) * 1000 - successfulWatch.startTime;
  successfulWatch.references = [
    {
      refType: "CHILD_OF",
      traceID: warmView.trace.traceID,
      spanID: warmView.ui.spanID,
    },
  ];
  successfulWatch.tags = successfulWatch.tags.filter(
    (f) =>
      ![
        "error",
        "error.type",
        "otel.status_code",
        "antnest.outcome",
        "antnest.operation.phase",
        "antnest.stream.termination",
      ].includes(f.key),
  );
  successfulWatch.logs = [];
  warmView.trace.spans.push(successfulWatch);
  result.cleanupSearches = {
    found: {
      close: structuredClone(closes),
      deletion: structuredClone(closes),
    },
    rounds: {
      close: Array.from({ length: 3 }, () => structuredClone(closes)),
      deletion: Array.from({ length: 3 }, () => structuredClone(closes)),
    },
    errors: [],
  };
  return result;
}
const check = (f, secrets = [], options) =>
  inspectOutageStreams(f.evidence, f, secrets, options);
function syncCloseSearches(f) {
  const closes = [...f.traces.values()].filter((t) =>
    t.spans.some((s) => s.operationName === "agent_ui.acp.close"),
  );
  const deletions = closes.filter((t) =>
    t.spans.some(
      (s) =>
        tag(s, "http.request.method") === "DELETE" &&
        tag(s, "http.route") === "/v1/acp",
    ),
  );
  f.cleanupSearches = {
    found: {
      close: structuredClone(closes),
      deletion: structuredClone(deletions),
    },
    rounds: {
      close: Array.from({ length: 3 }, () => structuredClone(closes)),
      deletion: Array.from({ length: 3 }, () => structuredClone(deletions)),
    },
    errors: [],
  };
}
function shiftService(f, service, delta) {
  for (const trace of f.traces.values())
    for (const span of trace.spans) {
      if (trace.processes[span.processID].serviceName !== service) continue;
      span.startTime += delta;
      for (const log of span.logs ?? []) log.timestamp += delta;
    }
  syncCloseSearches(f);
}
test("stream independently calibrates ACP and UI instead of using Gateway or Docker wall clocks", () => {
  const f = fixture();
  shiftService(f, "agent-acp-service", 7000000);
  shiftService(f, "agent-ui", -5000000);
  assert.equal(check(f).status, "passed");
});
test("stream lifecycle keeps Docker timestamps independent of the observer wall clock", () => {
  const f = fixture();
  for (const lifecycle of [
    ...f.evidence.consumer_restarts,
    f.evidence.ui_drain,
  ])
    for (const state of [lifecycle.before, lifecycle.after])
      for (const key of ["started_at", "finished_at"])
        state[key] = new Date(Date.parse(state[key]) + 7000).toISOString();
  assert.equal(check(f).status, "passed");
});
test("stream rejects a successful private watch ending after the observed UI drain", () => {
  const f = fixture(),
    span = f.parts["warm-workspace-view"].trace.spans.find(
      (s) => s.spanID === "successful-watch",
    );
  span.duration = (epoch + 30000) * 1000 - span.startTime;
  assert.throws(() => check(f), /private stream.*lifecycle/);
});
test("stream rejects normal close finishing after its observed UI process lifetime", () => {
  const f = fixture(),
    trace = f.traces.get("d".repeat(31) + "2");
  for (const span of trace.spans) span.startTime = (epoch + 30000) * 1000;
  syncCloseSearches(f);
  assert.throws(() => check(f), /close.*lifecycle/);
});
test("complete DELETE cannot end after the observed UI drain", () => {
  const f = fixture(),
    deletion = f.traces.get("d".repeat(31) + "2").spans[1];
  deletion.duration = (epoch + 30000) * 1000 - deletion.startTime;
  syncCloseSearches(f);
  assert.throws(() => check(f), /DELETE.*lifecycle/);
});
test("old-owner DELETE cannot extend into a later ACP process generation", () => {
  const f = fixture(),
    deletion = f.traces.get("d".repeat(31) + "1").spans[1];
  deletion.duration = (epoch + 2400) * 1000 - deletion.startTime;
  syncCloseSearches(f);
  assert.throws(() => check(f), /DELETE.*lifecycle/);
});
test("complete DELETE must be causally compatible with its actual UI close", () => {
  const f = restoredOwnerFixture(),
    deletion = f.traces.get("d".repeat(31) + "2").spans[1];
  deletion.startTime += 1000000;
  syncCloseSearches(f);
  assert.throws(() => check(f), /DELETE.*close/);
});
function stoppedPeerCloseFixture(causes = '["unknown","connection_refused"]') {
  const f = fixture(),
    trace = f.traces.get("d".repeat(31) + "1"),
    close = trace.spans[0];
  trace.spans = [close];
  for (const [key, value] of Object.entries({
    trigger: "transport_failure",
    outcome: "failed",
    delete_responses: 0,
    delete_completed: 0,
    delete_status: 0,
    failures: 1,
  }))
    setTag(close, closePrefix + key, value);
  setTag(close, "error", true);
  setTag(close, "otel.status_code", "ERROR");
  close.logs = [
    {
      timestamp: close.startTime + 1,
      fields: fields({
        event: "antnest.ui.acp.close.failure",
        stage: "delete_request",
        causes,
        truncated: false,
      }),
    },
  ];
  f.failedClose = close;
  syncCloseSearches(f);
  return f;
}
function executionClockFixture() {
  const f = fixture(),
    p = f.parts["prep-view"],
    s = structuredClone(p.initialize);
  s.spanID = "execution-clock";
  s.operationName = "HTTP GET unmatched";
  s.startTime = p.ui.startTime + 3000;
  s.duration = 1000;
  s.tags = fields({
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "unmatched",
    "http.response.status_code": 200,
    "antnest.listener": "workspace",
    "rpc.method": "read_workspace_execution",
    "rpc.service": "agent-acp",
    "rpc.system.name": "json-over-http",
  });
  p.trace.spans.push(s);
  f.executionClock = s;
  return f;
}
function withIndependentOutageClock(f) {
  const c = outageClockFixture(),
    delta = epoch * 1000 - c.epoch;
  const restart = f.evidence.consumer_restarts[0];
  restart.before.id = restart.after.id = c.evidence.acp_clock_probe.before.id;
  restart.before.host_name = restart.after.host_name = "acp-container";
  restart.before.at = 1600;
  restart.before.observed_at_ms = epoch + 1600;
  f.evidence.policy_revision = 4;
  f.evidence.acp_clock_probe = {
    before: restart.before,
    sample: {
      ...c.evidence.acp_clock_probe.sample,
      server_date: new Date(epoch + 1000).toUTCString(),
    },
    after: { ...restart.before, at: 1750, observed_at_ms: epoch + 1750 },
  };
  for (const [id, trace] of c.traces) {
    trace.spans[0].startTime += delta;
    f.traces.set(id, trace);
    f.archivedTraceIDs.add(id);
  }
  f.clockSearches = { ...c.clockSearches, now: epoch + 60000 };
  syncOutageClockSearch(f);
  return f;
}
test("current outage stream requires an independent pre-restart ACP probe", () => {
  const f = fixture();
  f.evidence.policy_revision = 4;
  assert.throws(() => check(f), /independent outage ACP clock probe missing/);
});
test("independent outage probe resolves a coarse clock interval crossing the actual stop", () => {
  const f = stoppedPeerCloseFixture();
  const marker = f.parts["prep-view"].marker;
  marker.duration = (epoch + 1810) * 1000 - marker.startTime;
  marker.logs[0].timestamp = end(marker) - 1;
  assert.throws(() => check(f), /watch before actual normal termination/);
  withIndependentOutageClock(f);
  const result = check(f);
  const clock = result.service_clocks.find(
    (r) => r.service === "agent-acp-service" && r.generation === 0,
  );
  assert.equal(result.status, "passed");
  assert(clock.outage_probe, "the independent health proof must be retained");
  assert(clock.offset_max_us - clock.offset_min_us < 10000);
  assert.equal(clock.outage_probe.candidates.length, 2);
});
test("the independent outage clock still rejects a watch actually ending before stop", () => {
  const f = withIndependentOutageClock(stoppedPeerCloseFixture());
  const marker = f.parts["prep-view"].marker;
  marker.duration = (epoch + 1790) * 1000 - marker.startTime;
  marker.logs[0].timestamp = end(marker) - 1;
  assert.throws(() => check(f), /watch before actual normal termination/);
});
test("completed Session view contributes its awaited execution-read clock window", () => {
  const f = executionClockFixture(),
    result = check(f);
  assert(
    result.service_clocks
      .find((c) => c.service === "agent-acp-service" && c.generation === 0)
      .samples.some((s) => s.span_id === f.executionClock.spanID),
  );
});
for (const [name, change] of [
  [
    "wrong HTTP parent",
    (f) => {
      f.executionClock.references[0].spanID =
        f.parts["prep-view"].upstream.spanID;
    },
  ],
  [
    "contradictory response",
    (f) => setTag(f.executionClock, "http.response.status_code", 503),
  ],
  [
    "contradictory clock window",
    (f) => {
      f.executionClock.startTime += 2000000;
    },
  ],
])
  test(`execution-read clock rejects ${name}`, () => {
    const f = executionClockFixture();
    change(f);
    assert.throws(() => check(f));
  });
test("stopped-peer close cannot use the old owner's shutdown to admit a later failed owner", () => {
  const f = fixture(),
    failed = stoppedPeerCloseFixture().failedClose,
    trace = f.traces.get("d".repeat(31) + "2"),
    original = trace.spans[0];
  trace.spans = [
    {
      ...structuredClone(failed),
      traceID: trace.traceID,
      startTime: original.startTime,
      references: original.references,
    },
  ];
  trace.spans[0].logs[0].timestamp = original.startTime + 1;
  syncCloseSearches(f);
  assert.throws(() => check(f), /another ACP generation/);
});
test("stopped-peer close requires zero actual DELETE receivers", () => {
  const f = stoppedPeerCloseFixture(),
    trace = f.traces.get(f.failedClose.traceID),
    deletion = fixture().traces.get(f.failedClose.traceID).spans[1];
  trace.spans.push(deletion);
  syncCloseSearches(f);
  assert.throws(() => check(f), /DELETE inventory/);
});
test("stopped-peer close cannot hide an actual DELETE receiver by renaming its operation", () => {
  const f = stoppedPeerCloseFixture(),
    trace = f.traces.get(f.failedClose.traceID),
    deletion = fixture().traces.get(f.failedClose.traceID).spans[1];
  deletion.operationName = "HTTP DELETE renamed";
  trace.spans.push(deletion);
  syncCloseSearches(f);
  assert.throws(() => check(f), /DELETE inventory/);
});
for (const key of Object.keys(completeCloseReceipt))
  test(`stopped-peer close rejects contradictory ${key}`, () => {
    const f = stoppedPeerCloseFixture(),
      value = tag(f.failedClose, closePrefix + key);
    setTag(
      f.failedClose,
      closePrefix + key,
      typeof value === "boolean" ? !value : value + 1,
    );
    syncCloseSearches(f);
    assert.throws(() => check(f), /close receipt/);
  });
for (const cause of [
  "connection_refused",
  "connection_reset",
  "broken_pipe",
  "socket_closed",
])
  for (const wrapped of [false, true]) {
    test(`stopped-peer close retains exact failed receipt for ${wrapped ? "wrapped " : ""}${cause}`, () => {
      const f = stoppedPeerCloseFixture(
          JSON.stringify(wrapped ? ["unknown", cause] : [cause]),
        ),
        before = JSON.stringify([...f.traces.values()]);
      const result = check(f);
      assert(
        result.owner_closes.some((r) => r.reason === "failed-acp-process-exit"),
      );
      assert(
        result.owned_error_spans.some(
          (r) =>
            r.span_id === f.failedClose.spanID &&
            r.trace_id === f.failedClose.traceID &&
            r.reason === "failed-acp-process-exit",
        ),
      );
      assert.equal(JSON.stringify([...f.traces.values()]), before);
    });
  }
for (const cause of [
  "unknown",
  "dns",
  "timeout",
  "abort",
  "body",
  "stream_cleanup",
])
  test(`stopped-peer close rejects ${cause}`, () => {
    assert.throws(
      () => check(stoppedPeerCloseFixture(JSON.stringify([cause]))),
      /stopped-peer close cause/,
    );
  });
for (const [name, change] of [
  [
    "later incarnation",
    (f) => {
      const old = f.traces.get("d".repeat(31) + "1"),
        later = f.traces.get("d".repeat(31) + "2");
      old.spans = structuredClone(later.spans);
      for (const s of old.spans) {
        s.traceID = old.traceID;
        for (const r of s.references)
          if (r.refType === "CHILD_OF") r.traceID = old.traceID;
      }
    },
  ],
  [
    "missing ERROR",
    (f) => {
      f.failedClose.tags = f.failedClose.tags.filter((t) => t.key !== "error");
    },
  ],
  [
    "requested trigger",
    (f) => setTag(f.failedClose, closePrefix + "trigger", "requested"),
  ],
  [
    "missing failure event",
    (f) => {
      f.failedClose.logs = [];
    },
  ],
  [
    "extra failure event",
    (f) => {
      f.failedClose.logs.push(structuredClone(f.failedClose.logs[0]));
    },
  ],
  [
    "truncated failure event",
    (f) => {
      f.failedClose.logs[0].fields.find((t) => t.key === "truncated").value =
        true;
    },
  ],
  [
    "wrong failure stage",
    (f) => {
      f.failedClose.logs[0].fields.find((t) => t.key === "stage").value =
        "delete_body";
    },
  ],
  [
    "extra failure cause",
    (f) => {
      f.failedClose.logs[0].fields.find((t) => t.key === "causes").value =
        '["connection_reset","socket_closed"]';
    },
  ],
])
  test(`stopped-peer close rejects ${name}`, () => {
    const f = stoppedPeerCloseFixture();
    change(f);
    syncCloseSearches(f);
    assert.throws(() => check(f));
  });
test("stream requires complete producer cleanup receipts for every owner", () => {
  const result = check(fixture());
  assert.equal(result.owner_closes.length, 2);
  assert(result.owner_closes.every((r) => r.reason === "complete-delete-202"));
});
for (const key of Object.keys(completeCloseReceipt)) {
  test(`stream rejects missing close receipt ${key}`, () => {
    const f = fixture(),
      close = f.traces.get("d".repeat(31) + "2").spans[0];
    close.tags = close.tags.filter((t) => t.key !== closePrefix + key);
    syncCloseSearches(f);
    assert.throws(() => check(f), /close receipt/);
  });
  test(`stream rejects contradictory close receipt ${key}`, () => {
    const f = fixture(),
      close = f.traces.get("d".repeat(31) + "2").spans[0];
    setTag(
      close,
      closePrefix + key,
      typeof completeCloseReceipt[key] === "boolean"
        ? !completeCloseReceipt[key]
        : completeCloseReceipt[key] + 1,
    );
    syncCloseSearches(f);
    assert.throws(() => check(f), /close receipt/);
  });
}
for (const [name, change] of [
  ["unobserved trigger", (c) => setTag(c, closePrefix + "trigger", "unknown")],
  [
    "unexpected receipt field",
    (c) => setTag(c, closePrefix + "invented", true),
  ],
  ["extra exception", (c) => setTag(c, "exception.type", "private-error")],
  [
    "successful close with ERROR",
    (c) => {
      setTag(c, "error", true);
      setTag(c, "otel.status_code", "ERROR");
    },
  ],
  [
    "successful close event",
    (c) => {
      c.logs = [
        {
          timestamp: c.startTime,
          fields: fields({
            event: "antnest.ui.acp.close.failure",
            stage: "delete_request",
            causes: '["connection_refused"]',
            truncated: false,
          }),
        },
      ];
    },
  ],
])
  test(`stream rejects ${name}`, () => {
    const f = fixture(),
      close = f.traces.get("d".repeat(31) + "2").spans[0];
    change(close);
    syncCloseSearches(f);
    assert.throws(() => check(f));
  });
test("owning stream requires the complete cleanup inventory", () => {
  const f = fixture();
  delete f.cleanupSearches;
  assert.throws(() => check(f), /inventory/);
});
test("owning stream rejects an epoch shared across observed UI restart", () => {
  const f = fixture();
  f.parts["prep-view"].row.body.bridgeEpoch = "new-ui-epoch";
  assert.throws(() => check(f), /epoch/);
});
test("owning stream retains successful execution-watch inventory under actual owners", () => {
  const result = check(fixture());
  assert.equal(result.owner_inventory.owners.length, 2);
  assert.equal(
    result.owner_inventory.owners.flatMap((o) => o.streams).length,
    10,
  );
});
test("stream follows POST creation and Agent-view initialization before later Session views", () => {
  const f = fixture(),
    prep = f.parts["prep-view"],
    warm = f.parts["warm-workspace-view"];
  prep.row.label = "prep-session-create";
  prep.row.path = "/api/app/workspace/v1/agents/agent/sessions";
  prep.row.method = "POST";
  prep.row.status = 201;
  prep.row.body = { sessionId: f.evidence.session_id };
  prep.root.operationName = "HTTP POST /api/app/workspace/v1/{path...}";
  prep.upstream.operationName = "HTTP POST agent-ui";
  for (const s of [prep.root, prep.upstream, prep.ui]) {
    setTag(s, "http.request.method", "POST");
    setTag(s, "http.response.status_code", 201);
  }
  const prepView = f.make(
    "actual-prep-view",
    1100,
    1200,
    prep.row.credential_scope,
    f.evidence.session_id,
  );
  prepView.row.label = "prep-view";
  warm.row.label = "fresh-consumer-agent-ready";
  warm.row.path = "/api/app/workspace/v1/agents/agent/view";
  warm.row.body = {
    agentId: "agent",
    bridgeEpoch: "new-ui-epoch",
    availability: "ready",
    activeSessionId: null,
  };
  const later = f.make(
    "actual-warm-view",
    3100,
    3200,
    warm.row.credential_scope,
    f.evidence.session_id,
  );
  later.row.label = "warm-workspace-view";
  const moved = warm.watches.pop();
  warm.trace.spans.splice(warm.trace.spans.indexOf(moved), 1);
  later.watch();
  for (const p of [prepView, later]) f.archivedTraceIDs.add(p.trace.traceID);
  const result = check(f);
  assert.equal(result.owner_inventory.owners[0].origin_kind, "session-create");
  const owner = result.owner_inventory.owners.find(
    (o) => o.origin_trace_id === warm.trace.traceID,
  );
  assert(
    owner.streams.some(
      (s) =>
        s.trace_id === later.trace.traceID && s.ui_span_id === later.ui.spanID,
    ),
  );
  assert.equal(result.owned_error_spans.length, 19);
});
test("stream claims bind five remote retirements and actual retained internal watches without changing raw errors", () => {
  const f = fixture(),
    before = structuredClone(f.traces),
    result = check(f);
  assert.equal(result.status, "passed");
  assert.equal(result.streams.length, 5);
  assert.equal(result.internal_watches.length, 10);
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

function neutralPublicStream(f = offboardingFixture()) {
  const p = f.parts["deactivate-stream"];
  for (const span of [p.root, p.upstream]) {
    span.tags = span.tags.filter(
      ({ key }) => !/^(error($|\.)|otel\.status_|antnest\.error\.)/u.test(key),
    );
    span.logs = [];
  }
  f.evidence.recovery.cases[3].stream.closure.kind = "remote-end";
  p.ui.logs = [
    {
      timestamp: end(p.ui) - 1,
      fields: fields({
        event: "antnest.stream.termination",
        reason: "access_denied",
        source: "agent-execution-state",
        "antnest.organization.id": "org",
        "antnest.principal.id": "user",
        "antnest.agent.id": "agent",
      }),
    },
  ];
  f.public = p;
  return f;
}

test("normal public EOF requires its direct scoped witness and does not invent two errors", () => {
  const f = neutralPublicStream(),
    before = structuredClone({ evidence: f.evidence, traces: f.traces });
  const result = checkOffboarding(f);
  assert.equal(result.status, "passed");
  assert.equal(result.owned_error_spans.length, 17);
  assert.equal(result.error_spans, 18);
  assert.equal(f.proofCalls, 1);
  assert.deepEqual(
    result.streams.find((row) => row.name === "deactivate").termination,
    {
      reason: "access_denied",
      source: "agent-execution-state",
      span_id: f.public.ui.spanID,
    },
  );
  assert(
    !result.owned_error_spans.some(
      (row) => row.trace_id === f.public.trace.traceID,
    ),
  );
  assert.deepEqual({ evidence: f.evidence, traces: f.traces }, before);
});

const neutralField = (f, key, value) => {
  f.public.ui.logs[0].fields.find((field) => field.key === key).value = value;
};
for (const [name, change] of [
  [
    "missing direct witness",
    (f) => {
      f.public.ui.logs = [];
    },
  ],
  ["different event", (f) => neutralField(f, "event", "unrelated")],
  ["different reason", (f) => neutralField(f, "reason", "shutdown")],
  ["different source", (f) => neutralField(f, "source", "learning-notice")],
  ...["organization", "principal", "agent"].map((key) => [
    `foreign ${key}`,
    (f) => neutralField(f, `antnest.${key}.id`, "foreign"),
  ]),
  [
    "duplicate witness",
    (f) => f.public.ui.logs.push(structuredClone(f.public.ui.logs[0])),
  ],
  [
    "extra field",
    (f) =>
      f.public.ui.logs[0].fields.push({
        key: "detail",
        value: "private-canary",
      }),
  ],
  [
    "duplicate field",
    (f) =>
      f.public.ui.logs[0].fields.push({
        key: "reason",
        value: "access_denied",
      }),
  ],
  [
    "before owning span",
    (f) => {
      f.public.ui.logs[0].timestamp = f.public.ui.startTime - 1;
    },
  ],
  [
    "after owning span",
    (f) => {
      f.public.ui.logs[0].timestamp = end(f.public.ui) + 1;
    },
  ],
  [
    "before actual mutation",
    (f) => {
      f.public.ui.logs[0].timestamp = (epoch + 24000) * 1000;
    },
  ],
  [
    "after public EOF",
    (f) => {
      f.public.ui.logs[0].timestamp =
        (epoch + f.evidence.recovery.cases[3].stream.closure.at + 1500) * 1000;
    },
  ],
  [
    "transport failure instead of EOF",
    (f) => {
      f.evidence.recovery.cases[3].stream.closure.kind = "transport-end";
    },
  ],
  [
    "wrong parent",
    (f) => {
      f.public.ui.references[0].spanID = f.public.root.spanID;
    },
  ],
  ["wrong route", (f) => setTag(f.public.ui, "http.route", "/other")],
  [
    "wrong status",
    (f) => setTag(f.public.ui, "http.response.status_code", 403),
  ],
  ["error on UI", (f) => setTag(f.public.ui, "error", true)],
  ["only root error", (f) => setTag(f.public.root, "error", true)],
  ["only upstream error", (f) => setTag(f.public.upstream, "error", true)],
  [
    "unrelated SQL error",
    (f) =>
      setTag(
        f.public.trace.spans.find((span) => span.spanID === "sql"),
        "error",
        true,
      ),
  ],
  [
    "unproved recovery",
    (f) => {
      f.proof.status = "pending";
    },
  ],
  [
    "missing commit proof",
    (f) => {
      f.proof.mutations = [];
    },
  ],
  [
    "rolled back mutation",
    (f) => setTag(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "missing disabled readback",
    (f) => {
      f.evidence.http = f.evidence.http.filter(
        (row) => row !== f.evidence.recovery.cases[3].disabled_agent,
      );
    },
  ],
  [
    "still active Agent",
    (f) => {
      f.evidence.recovery.cases[3].disabled_agent.body.activation_state =
        "enabled";
    },
  ],
  [
    "witness on another request",
    (f) => {
      f.parts["deactivate-view"].ui.logs = f.public.ui.logs;
      f.public.ui.logs = [];
    },
  ],
])
  test(`normal public EOF rejects ${name}`, () => {
    const f = neutralPublicStream();
    change(f);
    assert.throws(() => checkOffboarding(f));
  });

function concurrentGatewayRetirement(f = neutralPublicStream()) {
  const original = fixture().parts["deactivate-stream"];
  for (const key of ["root", "upstream"]) {
    f.public[key].tags = original[key].tags;
    f.public[key].logs = original[key].logs;
  }
  f.evidence.recovery.cases[3].stream.closure.kind = "transport-end";
  return f;
}

test("concurrent Gateway retirement preserves its two errors and validates the UI witness", () => {
  const f = concurrentGatewayRetirement(),
    before = structuredClone({ evidence: f.evidence, traces: f.traces });
  const result = checkOffboarding(f);
  assert.equal(result.status, "passed");
  assert.equal(result.owned_error_spans.length, 19);
  assert.equal(result.error_spans, 20);
  assert.equal(f.proofCalls, 1);
  assert.deepEqual(
    result.owned_error_spans
      .filter((row) => row.trace_id === f.public.trace.traceID)
      .map((row) => row.span_id)
      .sort(),
    [f.public.root.spanID, f.public.upstream.spanID].sort(),
  );
  assert.equal(
    result.streams.find((row) => row.name === "deactivate").termination.span_id,
    f.public.ui.spanID,
  );
  assert.deepEqual({ evidence: f.evidence, traces: f.traces }, before);
});

for (const [name, change] of [
  ["foreign scope", (f) => neutralField(f, "antnest.principal.id", "foreign")],
  ["wrong reason", (f) => neutralField(f, "reason", "shutdown")],
  ["wrong source", (f) => neutralField(f, "source", "learning-notice")],
  [
    "duplicate witness",
    (f) => f.public.ui.logs.push(structuredClone(f.public.ui.logs[0])),
  ],
  [
    "extra witness field",
    (f) =>
      f.public.ui.logs[0].fields.push({
        key: "detail",
        value: "private-canary",
      }),
  ],
  [
    "witness outside owning span",
    (f) => {
      f.public.ui.logs[0].timestamp = end(f.public.ui) + 1;
    },
  ],
  [
    "witness before mutation",
    (f) => {
      f.public.ui.logs[0].timestamp = (epoch + 24000) * 1000;
    },
  ],
  [
    "unproved recovery",
    (f) => {
      f.proof.status = "pending";
    },
  ],
  [
    "rolled back mutation",
    (f) => setTag(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  ["UI error", (f) => setTag(f.public.ui, "error", true)],
  [
    "different Gateway handler error",
    (f) => setTag(f.public.root, "otel.status_description", "other"),
  ],
  [
    "missing Gateway response error",
    (f) => {
      f.public.upstream.logs = [];
    },
  ],
])
  test(`concurrent Gateway retirement rejects ${name}`, () => {
    const f = concurrentGatewayRetirement();
    change(f);
    assert.throws(() => checkOffboarding(f));
  });

// Compose the independently validated recovery observations/SQL with the
// stream fixture. Explicitly namespace Trace IDs and map synthetic observation
// times; no production evidence is modified and no recovery verdict is stubbed.
function fullRecoveryStreamFixture() {
  const f = fixture(),
    recovery = recoveryHTTPFixture();
  const visited = new WeakSet();
  const namespace = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (["trace_id", "traceID"].includes(key) && typeof child === "string")
        value[key] = (BigInt("0x" + child) + 0x1000n)
          .toString(16)
          .padStart(32, "0");
      else namespace(child);
    }
  };
  namespace(recovery.evidence);
  for (const trace of recovery.traces.values()) namespace(trace);
  const replaced = new Set();
  for (const [index, source] of recovery.evidence.recovery.cases.entries()) {
    const target = f.evidence.recovery.cases[index],
      start = source.login.at,
      base = target.login.at,
      session = source.session_id,
      oldScope = source.login.issued_credential_scope;
    const seen = new WeakSet();
    const move = (value) => {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (
          typeof child === "number" &&
          [
            "at",
            "started_at",
            "headers_at",
            "observed_at",
            "observed_at_ms",
            "received_at_ms",
            "released_at_ms",
            "disconnected_at_ms",
          ].includes(key)
        )
          value[key] = base + (child - start) * 40;
        else if (typeof child === "string")
          value[key] =
            child === oldScope
              ? target.login.issued_credential_scope
              : child === "membership"
                ? "member"
                : child
                    .replaceAll(session, target.session_id)
                    .replaceAll(
                      "/memberships/membership",
                      "/memberships/member",
                    );
        else move(child);
      }
    };
    move(source);
    source.trigger.observed_at_ms = epoch + source.trigger.at;
    replaced.add(source.login);
    replaced.add(source.mutation);
    replaced.add(source.initial_view);
    // Retain the stream fixture's actual view Trace and its owned watches.
    // Place the new Bridge create receipt after peer login and before that
    // existing read instead of adding an unobserved second view request.
    source.session_create.started_at = target.initial_view.started_at - 40;
    source.session_create.at = target.initial_view.started_at - 1;
    target.initial_view.body = {
      ...source.initial_view.body,
      bridgeEpoch: target.initial_view.body.bridgeEpoch,
    };
    Object.assign(target.login, source.login);
    Object.assign(target.mutation, source.mutation);
    target.stream.records = source.stream.records;
    target.stream.started_at_ms = epoch + target.stream.started_at;
    Object.assign(target, source, {
      login: target.login,
      mutation: target.mutation,
      stream: target.stream,
      session_id: target.session_id,
      initial_view: target.initial_view,
    });
  }
  f.evidence.http.push(
    ...recovery.evidence.http.filter((row) => !replaced.has(row)),
  );
  f.evidence.model_observations = recovery.evidence.model_observations;
  Object.assign(f.evidence.identity.healthy, {
    running: true,
    health: "healthy",
  });
  for (const trace of recovery.traces.values()) {
    assert(!f.traces.has(trace.traceID));
    f.traces.set(trace.traceID, trace);
    f.archivedTraceIDs.add(trace.traceID);
  }
  f.recoveryParts = recovery.parts;
  addRestoredDenialHTTP(f);
  return neutralPublicStream(f);
}

test("combined stream fixture supplies complete real-inspector recovery prerequisites", () => {
  const f = fullRecoveryStreamFixture();
  assert.equal(inspectRecoveryHTTP(f.evidence, f).status, "passed");
});

function addRestoredDenialHTTP(f) {
  const c = f.evidence.recovery.cases[3],
    at = c.restored_state.started_at,
    p = f.make(
      "restored-owner",
      at,
      c.restored_state.at,
      c.fresh_login.issued_credential_scope,
      f.evidence.session_id,
    );
  const placeholder = p.row;
  c.restored_state.trace_id = p.trace.traceID;
  c.restored_state.server_date = placeholder.server_date;
  p.row = c.restored_state;
  f.evidence.http.splice(f.evidence.http.indexOf(placeholder), 1);
  for (const s of [p.root, p.upstream, p.ui])
    setTag(s, "http.response.status_code", 403);
  for (const [key, value] of Object.entries({
    error: true,
    "otel.status_code": "ERROR",
    "error.type": "403",
    "otel.status_description": "HTTP status 403",
  }))
    setTag(p.upstream, key, value);
  p.ui.logs = [
    {
      timestamp: p.ui.startTime + 1,
      fields: fields({
        event: "antnest.ui.agent_view.failure",
        stage: "view",
        causes: '["agent_access_revoked"]',
        truncated: false,
      }),
    },
  ];
  f.archivedTraceIDs.add(p.trace.traceID);
  f.restoredOwner = p;
}

function restoredOwnerFixture() {
  const f = fullRecoveryStreamFixture(),
    p = f.restoredOwner,
    at = p.row.started_at;
  const init = structuredClone(f.parts["prep-view"].initialize);
  init.traceID = p.trace.traceID;
  init.startTime = p.ui.startTime + 1000;
  init.references = [
    { refType: "CHILD_OF", traceID: p.trace.traceID, spanID: p.ui.spanID },
  ];
  p.trace.spans.push(init);
  p.watch();
  const successful = structuredClone(
    f.parts["warm-workspace-view"].trace.spans.find(
      (s) => s.spanID === "successful-watch",
    ),
  );
  successful.traceID = p.trace.traceID;
  successful.startTime = p.ui.startTime + 2000;
  successful.duration = 1000;
  successful.references = [
    { refType: "CHILD_OF", traceID: p.trace.traceID, spanID: p.ui.spanID },
  ];
  p.trace.spans.push(successful);
  const warmClose = f.traces.get("d".repeat(31) + "2"),
    finalClose = structuredClone(warmClose),
    id = "d".repeat(31) + "3";
  finalClose.traceID = id;
  for (const s of finalClose.spans) {
    s.traceID = id;
    for (const ref of s.references)
      ref.traceID = ref.refType === "FOLLOWS_FROM" ? p.trace.traceID : id;
  }
  finalClose.spans[0].references[0].spanID = p.ui.spanID;
  for (const s of warmClose.spans) s.startTime = (epoch + at - 5) * 1000;
  // The old owner's GETs retire on the proved deactivation; the restored
  // owner is a new incarnation and its GET remains until final drain.
  for (const [name, part] of Object.entries(f.parts))
    if (name !== "prep-view" && part !== p)
      for (const s of part.watches) {
        s.duration = (epoch + at - 10) * 1000 - s.startTime;
        s.logs = [
          {
            timestamp: end(s) - 1,
            fields: fields({
              event: "antnest.stream.termination",
              reason: "access_denied",
              "error.type": "DomainError",
              source: "learning-notice",
              "antnest.agent.id": "agent",
              "antnest.organization.id": "org",
            }),
          },
        ];
      }
  const oldWatch = f.parts["warm-workspace-view"].trace.spans.find(
    (s) => s.spanID === "successful-watch",
  );
  oldWatch.duration = (epoch + at - 10) * 1000 - oldWatch.startTime;
  f.traces.set(id, finalClose);
  for (const traceID of [p.trace.traceID, id]) f.archivedTraceIDs.add(traceID);
  const closes = [...f.traces.values()].filter((t) =>
    t.spans.some((s) => s.operationName === "agent_ui.acp.close"),
  );
  f.cleanupSearches = {
    found: {
      close: structuredClone(closes),
      deletion: structuredClone(closes),
    },
    rounds: {
      close: Array.from({ length: 3 }, () => structuredClone(closes)),
      deletion: Array.from({ length: 3 }, () => structuredClone(closes)),
    },
    errors: [],
  };
  f.restoredOwner = p;
  return f;
}

test("restored disabled-Agent 403 without a new private request is owned using complete recovery evidence", () => {
  const f = fullRecoveryStreamFixture(),
    before = structuredClone({ evidence: f.evidence, traces: f.traces }),
    p = f.restoredOwner,
    result = check(f);
  assert.equal(result.owner_inventory.owners.length, 2);
  assert(
    !p.trace.spans.some(
      (s) => p.trace.processes[s.processID].serviceName === "agent-acp-service",
    ),
  );
  assert.deepEqual(
    result.owned_error_spans.filter((s) => s.trace_id === p.trace.traceID),
    [
      {
        trace_id: p.trace.traceID,
        span_id: p.upstream.spanID,
        reason: "restored-disabled-agent-view",
      },
    ],
  );
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual({ evidence: f.evidence, traces: f.traces }, before);
});

for (const [name, change] of [
  [
    "incomplete deactivation proof",
    (f) => {
      f.evidence.recovery.cases[3].disabled_agent.status = 503;
    },
  ],
  [
    "extra forwarding exception",
    (f) => setTag(f.restoredOwner.upstream, "exception.type", "other"),
  ],
  [
    "missing forwarding error",
    (f) => {
      f.restoredOwner.upstream.tags = f.restoredOwner.upstream.tags.filter(
        (v) => !v.key.startsWith("error") && !v.key.startsWith("otel.status"),
      );
    },
  ],
  [
    "extra forwarding event",
    (f) => {
      f.restoredOwner.upstream.logs = [
        {
          timestamp: f.restoredOwner.upstream.startTime,
          fields: fields({ event: "antnest.error" }),
        },
      ];
    },
  ],
  ["Resolve error", (f) => setTag(f.restoredOwner.decision, "error", true)],
  [
    "SQL error",
    (f) =>
      setTag(
        f.restoredOwner.trace.spans.find((s) => s.spanID === "sql"),
        "error",
        true,
      ),
  ],
  [
    "duplicate denial event",
    (f) => {
      f.restoredOwner.ui.logs.push(structuredClone(f.restoredOwner.ui.logs[0]));
    },
  ],
])
  test(`restored denial without a private request rejects ${name}`, () => {
    const f = fullRecoveryStreamFixture();
    change(f);
    assert.throws(() =>
      check(f, [], { inspectRecovery: () => ({ status: "passed" }) }),
    );
  });

test("restored disabled-Agent 403 can initialize an owner only with complete recovery proof and its exact forwarding error", () => {
  const f = restoredOwnerFixture(),
    result = check(f);
  assert.equal(result.owner_inventory.owners.length, 3);
  assert(
    result.owned_error_spans.some(
      (s) =>
        s.trace_id === f.restoredOwner.trace.traceID &&
        s.span_id === f.restoredOwner.upstream.spanID &&
        s.reason === "restored-disabled-agent-view",
    ),
  );
});
test("restored owner cannot replace complete recovery with an injected passed marker", () => {
  const f = restoredOwnerFixture();
  f.evidence.recovery.cases[3].disabled_agent.status = 503;
  assert.throws(() =>
    check(f, [], { inspectRecovery: () => ({ status: "passed" }) }),
  );
});
for (const [name, change] of [
  [
    "extra forwarding exception",
    (f) => setTag(f.restoredOwner.upstream, "exception.type", "other"),
  ],
  [
    "missing forwarding failure",
    (f) => {
      f.restoredOwner.upstream.tags = f.restoredOwner.upstream.tags.filter(
        (v) => !v.key.startsWith("error") && !v.key.startsWith("otel.status"),
      );
    },
  ],
  [
    "extra forwarding event",
    (f) => {
      f.restoredOwner.upstream.logs = [
        {
          timestamp: f.restoredOwner.upstream.startTime,
          fields: fields({ event: "antnest.error" }),
        },
      ];
    },
  ],
])
  test(`restored owner rejects ${name}`, () => {
    const f = restoredOwnerFixture();
    change(f);
    assert.throws(() => check(f));
  });

function terminalPasswordRevalidation() {
  const f = fullRecoveryStreamFixture(),
    warm = f.parts["warm-stream"],
    mutation = f.recoveryParts.find((p) => p.action === "password"),
    c = f.evidence.recovery.cases.find((c) => c.name === "password");
  // Only synthetic fixture timestamps move; the real archived traces are immutable.
  const delta =
    (epoch + c.mutation.started_at + 5) * 1000 - mutation.root.startTime;
  for (const span of mutation.trace.spans) {
    span.startTime += delta;
    for (const log of span.logs ?? []) log.timestamp += delta;
  }
  const processTags = fields({
    "service.instance.id": "identity-instance",
    "host.name": "identity-host",
    "process.pid": 1,
  });
  mutation.trace.processes.identity.tags = structuredClone(processTags);
  warm.trace.processes.identity.tags = structuredClone(processTags);
  const decision = structuredClone(warm.decision);
  decision.spanID = "terminal-revalidation";
  decision.startTime = (epoch + c.mutation.at + 200) * 1000;
  decision.duration = 4000;
  for (const [key, value] of Object.entries({
    [resolvePrefix + "source"]: "rpc",
    [resolvePrefix + "outcome"]: "rejected",
    error: true,
    "otel.status_code": "ERROR",
    "otel.status_description": "rejected",
  }))
    setTag(decision, key, value);
  warm.trace.spans.push(decision);
  addResolveRPC(warm.trace, "-rejected", decision.startTime + 500);
  const client = warm.trace.spans.find(
      (s) => s.spanID === "resolve-client-rejected",
    ),
    server = warm.trace.spans.find(
      (s) => s.spanID === "resolve-server-rejected",
    ),
    sql = warm.trace.spans.find((s) => s.spanID === "sql-rejected");
  for (const [key, value] of Object.entries({
    "http.response.status_code": 401,
    error: true,
    "otel.status_code": "ERROR",
    "otel.status_description": "HTTP status 401",
    "error.type": "401",
  }))
    setTag(client, key, value);
  const identityError = {
    "antnest.error.cause_types": '["*domain.Error"]',
    "antnest.error.code": "unauthenticated",
    "antnest.error.message": "Authentication failed",
    "antnest.error.stage": "protocol",
    "antnest.error.type": "unauthenticated",
    "error.type": "unauthenticated",
  };
  for (const [key, value] of Object.entries({
    ...identityError,
    "http.response.status_code": 401,
    "antnest.outcome": "rejected",
    "antnest.result": "rejected",
  }))
    setTag(server, key, value);
  server.logs = [
    {
      timestamp: end(server) - 1,
      fields: fields({ event: "antnest.error", ...identityError }),
    },
  ];
  setTag(
    sql,
    "db.query.text",
    tag(
      mutation.trace.spans.find((s) => s.spanID === "sql"),
      "db.query.text",
    ),
  );
  setTag(sql, "pgx.rows_affected", 0);
  return {
    ...f,
    rejection: { warm, mutation, c, decision, client, server, sql },
  };
}

test("terminal RPC 401 binds the real committed password revocation without rewriting raw evidence", () => {
  const f = terminalPasswordRevalidation(),
    before = structuredClone({ evidence: f.evidence, traces: f.traces });
  assert.equal(inspectRecoveryHTTP(f.evidence, f).status, "passed");
  const result = check(f),
    stream = result.streams.find((s) => s.name === "warm");
  assert.equal(stream.revocation_verified, true);
  assert.equal(stream.gateway_revalidations.at(-1).outcome, "rejected");
  assert.equal(
    stream.terminal_rejection.mutation_trace_id,
    f.rejection.c.mutation.trace_id,
  );
  assert.equal(
    stream.terminal_rejection.commit_span_id,
    f.rejection.mutation.commit.spanID,
  );
  for (const span of [
    f.rejection.decision,
    f.rejection.client,
    f.rejection.server,
  ])
    assert(
      result.owned_error_spans.some(
        (s) => s.trace_id === span.traceID && s.span_id === span.spanID,
      ),
    );
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual({ evidence: f.evidence, traces: f.traces }, before);
});

for (const offset of [-120000000, 600000000])
  test(`terminal rejection uses Identity process order with independent clock offset ${offset}`, () => {
    const f = terminalPasswordRevalidation();
    for (const span of [
      ...f.rejection.mutation.trace.spans.filter(
        (s) => s.processID === "identity",
      ),
      f.rejection.server,
      f.rejection.sql,
    ]) {
      span.startTime += offset;
      for (const log of span.logs ?? []) log.timestamp += offset;
    }
    assert.equal(check(f).status, "passed");
  });

for (const [name, change] of [
  [
    "another principal",
    (f) => {
      f.rejection.c.login.body.principal = {
        ...f.rejection.c.login.body.principal,
        user_id: "other",
      };
    },
  ],
  [
    "wrong stream credential",
    (f) => {
      f.evidence.stream.credential_scope =
        f.rejection.c.login.issued_credential_scope;
    },
  ],
  [
    "missing COMMIT",
    (f) => {
      const p = f.rejection.mutation;
      p.trace.spans = p.trace.spans.filter((s) => s !== p.commit);
    },
  ],
  [
    "rolled back mutation",
    (f) =>
      setTag(
        f.rejection.mutation.transaction,
        "antnest.transaction.outcome",
        "rolled_back",
      ),
  ],
  [
    "missing revocation feed",
    (f) => {
      const p = f.rejection.mutation;
      p.trace.spans = p.trace.spans.filter(
        (s) => s.spanID !== "session-feed-0",
      );
    },
  ],
  [
    "unrevoked token row",
    (f) => setTag(f.rejection.sql, "pgx.rows_affected", 1),
  ],
  [
    "different token query",
    (f) => setTag(f.rejection.sql, "db.query.text", "SELECT 1"),
  ],
  ["SQL write", (f) => setTag(f.rejection.sql, "db.operation.name", "UPDATE")],
  [
    "extra decision error",
    (f) => setTag(f.rejection.decision, "error.type", "StorageError"),
  ],
  [
    "extra client exception",
    (f) => setTag(f.rejection.client, "exception.type", "StorageError"),
  ],
  [
    "extra protocol event",
    (f) => {
      f.rejection.server.logs.push(structuredClone(f.rejection.server.logs[0]));
    },
  ],
  [
    "different Identity instance",
    (f) => {
      const p = f.rejection.warm.trace.processes.identity;
      p.tags = p.tags.map((t) =>
        t.key === "service.instance.id" ? { ...t, value: "other" } : t,
      );
    },
  ],
  [
    "missing Identity host",
    (f) => {
      const p = f.rejection.warm.trace.processes.identity;
      p.tags = p.tags.filter((t) => t.key !== "host.name");
    },
  ],
  [
    "SELECT before committed mutation",
    (f) => {
      const p = f.rejection.mutation;
      const delta = f.rejection.sql.startTime + 1 - end(p.commit);
      for (const s of p.trace.spans) {
        s.startTime += delta;
        for (const log of s.logs ?? []) log.timestamp += delta;
      }
    },
  ],
  [
    "rejection before observed mutation",
    (f) => {
      for (const s of [f.rejection.decision, f.rejection.client])
        s.startTime -= 5000000;
    },
  ],
  [
    "rejection after remote closure",
    (f) => {
      for (const s of [f.rejection.decision, f.rejection.client])
        s.startTime += 5000000;
    },
  ],
  [
    "continued Resolve",
    (f) => {
      const s = structuredClone(f.rejection.decision);
      s.spanID += "-later";
      s.startTime += 5000;
      f.rejection.warm.trace.spans.push(s);
    },
  ],
  [
    "unavailable decision",
    (f) =>
      setTag(f.rejection.decision, resolvePrefix + "outcome", "unavailable"),
  ],
  [
    "unproved shared source",
    (f) => setTag(f.rejection.decision, resolvePrefix + "source", "shared"),
  ],
])
  test(`terminal stream rejection refuses ${name}`, () => {
    const f = terminalPasswordRevalidation();
    change(f);
    assert.throws(() => check(f));
  });

test("a supplied passed marker cannot replace complete terminal-rejection recovery admission", () => {
  const f = terminalPasswordRevalidation(),
    p = f.rejection.mutation;
  p.trace.spans = p.trace.spans.filter((s) => s.spanID !== "session-feed-0");
  assert.throws(() =>
    check(f, [], {
      inspectRecovery: () => ({ status: "passed", mutations: [] }),
    }),
  );
});

test("normal EOF passes the default recovery inspector with committed SQL and final denials", () => {
  const f = fullRecoveryStreamFixture(),
    before = structuredClone({ evidence: f.evidence, traces: f.traces });
  assert.equal(check(f).status, "passed");
  assert.deepEqual({ evidence: f.evidence, traces: f.traces }, before);
});
test("concurrent Gateway retirement also requires the complete default recovery inspector", () => {
  const f = concurrentGatewayRetirement(fullRecoveryStreamFixture());
  assert.equal(check(f).status, "passed");
  f.evidence.recovery.cases[3].disabled_agent.status = 503;
  assert.throws(() => check(f));
});
for (const [name, change] of [
  [
    "missing final denial",
    (f) => {
      f.evidence.recovery.cases[3].old_session.status = 200;
    },
  ],
  [
    "failed disabled readback",
    (f) => {
      f.evidence.recovery.cases[3].disabled_agent.status = 503;
    },
  ],
  [
    "missing actual commit",
    (f) => {
      const p = f.recoveryParts.find((p) => p.action === "deactivate");
      p.trace.spans = p.trace.spans.filter((span) => span !== p.commit);
    },
  ],
  [
    "missing principal invalidation",
    (f) => {
      const p = f.recoveryParts.find((p) => p.action === "deactivate");
      p.trace.spans = p.trace.spans.filter((span) => span !== p.principalFeed);
    },
  ],
])
  test(`default normal EOF proof rejects ${name}`, () => {
    const f = fullRecoveryStreamFixture();
    change(f);
    assert.throws(() => check(f));
  });

function completedViewRead(transport) {
  const f = fixture(),
    p = f.parts["prep-view"];
  const initialize = p.initialize,
    process = structuredClone(p.trace.processes.acp),
    read = addCompletedRead(
      p.trace,
      initialize,
      transport,
      f.evidence.agent_id,
    );
  p.trace.processes.acp = process;
  if (transport === "http")
    for (const [key, value] of Object.entries({
      "rpc.service": "acp",
      "rpc.system.name": "jsonrpc",
      "antnest.listener": "workspace",
    }))
      setTag(initialize, key, value);
  return {
    ...f,
    ...read,
  };
}
const setEvent = (event, key, value) => {
  event.fields = event.fields.filter((field) => field.key !== key);
  event.fields.push({ key, value });
};
test("Bridge outage rejects a retired WSS initialization even with a successful Runtime read", () => {
  assert.throws(() => check(completedViewRead("ws")));
});
// Both transports' diagnostic shapes remain covered in the shared diagnostic
// tests. This HTTP Bridge consumer must not admit a legacy WSS owner.
for (const transport of ["http"]) {
  test(`stream retains ${transport} completed read disconnect without an error claim`, () => {
    const f = completedViewRead(transport),
      before = structuredClone({ traces: f.traces, evidence: f.evidence }),
      result = check(f);
    assert.equal(result.owned_error_spans.length, 19);
    assert.deepEqual({ traces: f.traces, evidence: f.evidence }, before);
  });
  for (const [name, change] of [
    [
      "wrong initialize method",
      (f) => setTag(f.root, "rpc.method", "session/prompt"),
    ],
    [
      "wrong initialize Agent",
      (f) => setTag(f.root, "antnest.agent.id", "other"),
    ],
    ["failed HTTP", (f) => setTag(f.server, "http.response.status_code", 503)],
    [
      "failed operation",
      (f) => setTag(f.operation, "antnest.operation.outcome", "error"),
    ],
    [
      "failed protocol",
      (f) => setTag(f.server, "antnest.protocol.outcome", "error"),
    ],
    [
      "wrong execution",
      (f) => setTag(f.operation, "antnest.runtime.execution.id", "other"),
    ],
    [
      "missing cancellation",
      (f) => {
        f.server.logs = [f.completion];
      },
    ],
    [
      "missing completion",
      (f) => {
        f.server.logs = [f.cancelled];
      },
    ],
    [
      "extra server exception",
      (f) => setTag(f.server, "exception.type", "StorageError"),
    ],
    [
      "extra completion exception",
      (f) => setEvent(f.completion, "exception.type", "StorageError"),
    ],
    [
      "extra failed outcome",
      (f) => setEvent(f.completion, "executor.outcome", "error"),
    ],
    [
      "wrong completion span",
      (f) => setEvent(f.completion, "span_id", "foreign"),
    ],
    [
      "completion before operation",
      (f) => {
        f.completion.timestamp = f.operation.startTime;
      },
    ],
    [
      "duplicate completion diagnostic",
      (f) => {
        f.completion.fields.push({
          key: "error.type",
          value: "client_disconnected",
        });
      },
    ],
  ])
    test(`stream ${transport} completed read rejects ${name}`, () => {
      const f = completedViewRead(transport);
      change(f);
      assert.throws(() => check(f));
    });
}
for (const [key, value] of [
  ["http.request.method", "GET"],
  ["http.route", "/v2/acp"],
  ["http.response.status_code", 503],
])
  test(`stream HTTP initialize rejects wrong ${key}`, () => {
    const f = completedViewRead("http");
    setTag(f.root, key, value);
    assert.throws(() => check(f));
  });

for (const transport of ["http"])
  for (const [key, value] of [
    ["antnest.result", "rejected"],
    ["db.response.status_code", "XX001"],
    ["antnest.stream.termination", "access-denied"],
    ["antnest.http.request_cancelled", true],
  ])
    for (const where of ["span", "event"])
      test(`neutral ${transport} stream does not hide ${where} ${key}`, () => {
        const f = completedViewRead(transport);
        if (where === "span") setTag(f.server, key, value);
        else setEvent(f.completion, key, value);
        assert.throws(() => check(f));
      });
