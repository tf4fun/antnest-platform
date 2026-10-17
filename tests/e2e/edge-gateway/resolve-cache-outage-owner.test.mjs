import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageOwnerInventory } from "./resolve-cache-outage-owner.mjs";
import { fields } from "../observability/trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

function fixture() {
  let next = 1;
  const traces = new Map(),
    http = [],
    parts = {};
  const principal = {
    organization_id: "org",
    user_id: "user",
    membership_id: "member",
  };
  const base = "/api/app/workspace/v1/agents/agent";
  const evidence = {
    agent_id: "agent",
    session_id: "session",
    http,
    consumer_restarts: [
      {
        service: "agent-ui",
        before: { at: 2000 },
        started_at: 2001,
        after: { at: 3000 },
      },
    ],
    ui_drain: { before: { at: 9000 }, started_at: 9001, after: { at: 9200 } },
    recovery: { cases: [] },
  };
  const resource = (service) => ({
    serviceName: service,
    tags: fields({
      "host.name": service + "-container",
      "process.pid": 1,
      ...(service === "agent-acp-service"
        ? { "service.instance.id": "acp-container:1" }
        : {}),
    }),
  });
  const span = (trace, key, process, name, at, tags, parent) => {
    const s = {
      traceID: trace.traceID,
      spanID: key.toString(16).padStart(16, "0"),
      processID: process,
      operationName: name,
      startTime: at * 1000,
      duration: 500,
      tags: fields(tags),
      logs: [],
      references: parent
        ? [
            {
              refType: "CHILD_OF",
              traceID: trace.traceID,
              spanID: parent.spanID,
            },
          ]
        : [],
    };
    trace.spans.push(s);
    return s;
  };
  const login = (label, at) => {
    const row = {
      label,
      path: "/api/session/login",
      method: "POST",
      status: 200,
      set_cookie_count: 2,
      started_at: at,
      at: at + 1,
      issued_credential_scope: label + "-cookie",
      body: { principal: structuredClone(principal) },
    };
    http.push(row);
    return row;
  };
  const prepLogin = login("prep-login", 1),
    warmLogin = login("warm-login", 3010),
    peerLogin = login("peer-login", 4000),
    freshLogin = login("restored-login", 8000);
  const request = (
    name,
    at,
    login,
    path,
    method = "GET",
    status = 200,
    body,
  ) => {
    const traceID = (next++).toString(16).padStart(32, "0");
    const trace = {
      traceID,
      processes: {
        gateway: resource("edge-gateway"),
        ui: resource("agent-ui"),
        acp: resource("agent-acp-service"),
      },
      spans: [],
    };
    const root = span(
      trace,
      1,
      "gateway",
      `HTTP ${method} /api/app/workspace/v1/{path...}`,
      at,
      {
        "span.kind": "server",
        "http.request.method": method,
        "http.response.status_code": status,
        "http.route": "/api/app/workspace/v1/{path...}",
      },
    );
    const upstream = span(
      trace,
      2,
      "gateway",
      `HTTP ${method} agent-ui`,
      at + 1,
      {
        "span.kind": "client",
        "http.request.method": method,
        "http.response.status_code": status,
        "server.address": "agent-ui",
      },
      root,
    );
    const ui = span(
      trace,
      3,
      "ui",
      "agent_ui.http.request",
      at + 2,
      {
        "span.kind": "server",
        "http.request.method": method,
        "http.response.status_code": status,
        "http.route": "/api/app/workspace/v1/*",
      },
      upstream,
    );
    const row = {
      label: name,
      trace_id: traceID,
      path,
      method,
      status,
      set_cookie_count: 0,
      credential_scope: login.issued_credential_scope,
      started_at: at,
      at: at + 20,
      body: body ?? {
        agentId: "agent",
        sessionId: "session",
        bridgeEpoch: at < 2000 ? "old-ui-epoch" : "new-ui-epoch",
      },
    };
    http.push(row);
    traces.set(traceID, trace);
    return (parts[name] = { trace, root, upstream, ui, row, streams: [] });
  };
  const addStream = (p, kind = "get") => {
    const watch = kind === "watch",
      route = watch ? "/rpc/agent-acp/watch-agent-execution-state" : "/v1/acp";
    const s = span(
      p.trace,
      20 + p.streams.length,
      "acp",
      `HTTP ${watch ? "POST" : "GET"} ${route}`,
      p.row.started_at + 4,
      {
        "span.kind": "server",
        "http.request.method": watch ? "POST" : "GET",
        "http.route": route,
        "http.response.status_code": 200,
        "antnest.listener": watch ? "control" : "workspace",
        ...(watch
          ? {
              "rpc.method": "watch_agent_execution_state",
              "rpc.service": "agent-acp",
              "rpc.system.name": "json-over-http",
              "antnest.agent.id": "agent",
              "antnest.organization.id": "org",
            }
          : {}),
      },
      p.ui,
    );
    p.streams.push(s);
    return s;
  };
  const owner = (p, closedAt) => {
    p.initialize = span(
      p.trace,
      10,
      "acp",
      "HTTP POST /v1/acp",
      p.row.started_at + 3,
      {
        "span.kind": "server",
        "http.request.method": "POST",
        "http.route": "/v1/acp",
        "http.response.status_code": 200,
        "antnest.listener": "workspace",
        "rpc.method": "initialize",
        "rpc.service": "acp",
        "rpc.system.name": "jsonrpc",
        "antnest.agent.id": "agent",
      },
      p.ui,
    );
    const traceID = (next++).toString(16).padStart(32, "0");
    const trace = {
      traceID,
      processes: {
        ui: resource("agent-ui"),
        acp: resource("agent-acp-service"),
      },
      spans: [],
    };
    const close = span(trace, 1, "ui", "agent_ui.acp.close", closedAt, {
      "span.kind": "internal",
      "antnest.ui.acp.close.outcome": "closed",
    });
    close.references = [
      {
        refType: "FOLLOWS_FROM",
        traceID: p.trace.traceID,
        spanID: p.ui.spanID,
      },
    ];
    span(
      trace,
      2,
      "acp",
      "HTTP DELETE /v1/acp",
      closedAt + 0.1,
      {
        "span.kind": "server",
        "http.request.method": "DELETE",
        "http.route": "/v1/acp",
        "http.response.status_code": 202,
        "antnest.listener": "workspace",
      },
      close,
    );
    p.closeTrace = trace;
    p.close = close;
    traces.set(traceID, trace);
    addStream(p);
    addStream(p, "watch");
    return p;
  };
  owner(
    request("prep-create", 1000, prepLogin, `${base}/sessions`, "POST", 201, {
      sessionId: "session",
    }),
    1900,
  );
  addStream(parts["prep-create"]);
  request("prep-view", 1100, prepLogin, `${base}/sessions/session/view`);
  owner(request("fresh-ready", 3100, warmLogin, `${base}/view`), 7900);
  addStream(
    request("later-view", 4200, peerLogin, `${base}/sessions/session/view`),
  );
  const restored = owner(
    request("restored-denial", 8100, freshLogin, `${base}/view`, "GET", 403, {
      code: "access_denied",
      message: "Agent access denied",
      requestId: "00000000-0000-4000-8000-000000000001",
      retryable: false,
      recovery: "none",
    }),
    9100,
  );
  restored.ui.logs = [
    {
      timestamp: restored.ui.startTime + 1,
      fields: fields({
        event: "antnest.ui.agent_view.failure",
        stage: "view",
        causes: '["agent_access_revoked"]',
        truncated: false,
      }),
    },
  ];
  evidence.recovery.cases.push({
    name: "deactivate",
    login: login("deactivate-login", 7800),
    fresh_login: freshLogin,
    restored_state: restored.row,
  });
  const sync = () => {
    const rows = Object.values(parts)
      .filter((p) => p.closeTrace)
      .map((p) => structuredClone(p.closeTrace));
    f.cleanupSearches = {
      found: { close: structuredClone(rows), deletion: structuredClone(rows) },
      rounds: {
        close: Array.from({ length: 3 }, () => structuredClone(rows)),
        deletion: Array.from({ length: 3 }, () => structuredClone(rows)),
      },
      errors: [],
    };
    f.archivedTraceIDs = new Set(traces.keys());
  };
  const f = { evidence, traces, parts, addStream, request, owner, login, sync };
  sync();
  return f;
}
const check = (f) => inspectOutageOwnerInventory(f.evidence, f);

function restoredWithoutPrivateRequest() {
  const f = fixture(),
    p = f.parts["restored-denial"];
  p.trace.spans = p.trace.spans.filter((s) => s.processID !== "acp");
  f.traces.delete(p.closeTrace.traceID);
  delete p.closeTrace;
  f.sync();
  return f;
}

test("restored denial remains an HTTP origin without creating a private owner or stream", () => {
  const f = restoredWithoutPrivateRequest(),
    p = f.parts["restored-denial"],
    before = structuredClone(f.evidence),
    raw = structuredClone(f.traces),
    result = check(f);
  assert.equal(result.owners.length, 2);
  assert(!result.owners.some((o) => o.origin_trace_id === p.trace.traceID));
  assert.deepEqual(
    result.http_origins.filter((r) => r.trace_id === p.trace.traceID),
    [
      {
        trace_id: p.trace.traceID,
        ui_span_id: p.ui.spanID,
        generation: 1,
        kind: "restored-denial",
      },
    ],
  );
  assert.deepEqual(f.evidence, before);
  assert.deepEqual(f.traces, raw);
});

for (const [name, change] of [
  [
    "missing raw trace",
    (f) => f.traces.delete(f.parts["restored-denial"].trace.traceID),
  ],
  [
    "unarchived raw trace",
    (f) => f.archivedTraceIDs.delete(f.parts["restored-denial"].trace.traceID),
  ],
  [
    "missing HTTP receipt",
    (f) =>
      f.evidence.http.splice(
        f.evidence.http.indexOf(f.parts["restored-denial"].row),
        1,
      ),
  ],
  [
    "foreign recovery receipt",
    (f) => {
      f.evidence.recovery.cases[0].restored_state = structuredClone(
        f.parts["restored-denial"].row,
      );
      f.evidence.recovery.cases[0].restored_state.trace_id = "e".repeat(32);
    },
  ],
  [
    "missing recovery receipt",
    (f) => delete f.evidence.recovery.cases[0].restored_state,
  ],
  [
    "another issued credential",
    (f) => {
      f.parts["restored-denial"].row.credential_scope = f.evidence.http.find(
        (r) => r.label === "warm-login",
      ).issued_credential_scope;
    },
  ],
  [
    "another Principal",
    (f) => {
      f.evidence.recovery.cases[0].fresh_login.body.principal.user_id = "other";
    },
  ],
  [
    "foreign UI process",
    (f) => {
      f.parts["restored-denial"].trace.processes.ui.tags.find(
        (v) => v.key === "host.name",
      ).value = "foreign";
    },
  ],
  [
    "receipt crossing restart",
    (f) => {
      Object.assign(f.parts["restored-denial"].row, {
        started_at: 2500,
        at: 2520,
      });
    },
  ],
  [
    "missing denial event",
    (f) => {
      f.parts["restored-denial"].ui.logs = [];
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.parts["restored-denial"].row.path = f.parts[
        "restored-denial"
      ].row.path.replace("/agents/agent/", "/agents/other/");
    },
  ],
  [
    "wrong HTTP parent",
    (f) => {
      f.parts["restored-denial"].ui.references[0].spanID =
        f.parts["restored-denial"].root.spanID;
    },
  ],
])
  test(`restored denial without a private request rejects ${name}`, () => {
    const f = restoredWithoutPrivateRequest();
    change(f);
    assert.throws(() => check(f));
  });

test("actual initialization Links map POST, GET and denied origins plus every later private stream without changing raw evidence", () => {
  const f = fixture(),
    before = structuredClone({
      evidence: f.evidence,
      traces: f.traces,
      searches: f.cleanupSearches,
    });
  const result = check(f);
  assert.equal(result.status, "mapped_owning_admission_pending");
  assert.equal(result.owners.length, 3);
  assert.equal(result.owners.flatMap((o) => o.streams).length, 8);
  const warm = result.owners.find(
    (o) => o.origin_trace_id === f.parts["fresh-ready"].trace.traceID,
  );
  const later = warm.streams.find(
    (s) => s.trace_id === f.parts["later-view"].trace.traceID,
  );
  assert.equal(later.ui_span_id, f.parts["later-view"].ui.spanID);
  assert.equal(warm.bridge_epoch, "new-ui-epoch");
  assert.equal(result.owners[0].bridge_epoch, "old-ui-epoch");
  assert.deepEqual(
    { evidence: f.evidence, traces: f.traces, searches: f.cleanupSearches },
    before,
  );
});

for (const [name, change] of [
  [
    "missing private origin archive",
    (f) => f.archivedTraceIDs.delete(f.parts["later-view"].trace.traceID),
  ],
  [
    "missing initialization",
    (f) =>
      f.parts["prep-create"].trace.spans.splice(
        f.parts["prep-create"].trace.spans.indexOf(
          f.parts["prep-create"].initialize,
        ),
        1,
      ),
  ],
  [
    "unclosed initialization",
    (f) => {
      f.owner(
        f.request(
          "orphan",
          5000,
          f.login("orphan-login", 4900),
          "/api/app/workspace/v1/agents/agent/view",
        ),
        7000,
      );
      f.traces.delete(f.parts.orphan.closeTrace.traceID);
      delete f.parts.orphan.closeTrace;
      f.sync();
    },
  ],
  [
    "duplicate initialization under one origin",
    (f) => {
      const p = f.parts["fresh-ready"],
        s = structuredClone(p.initialize);
      s.spanID = "a".repeat(16);
      p.trace.spans.push(s);
    },
  ],
  [
    "duplicate close for one origin",
    (f) => {
      const p = f.parts["fresh-ready"],
        t = structuredClone(p.closeTrace);
      t.traceID = "e".repeat(32);
      for (const s of t.spans) {
        s.traceID = t.traceID;
        for (const r of s.references)
          if (r.refType === "CHILD_OF") r.traceID = t.traceID;
      }
      f.traces.set(t.traceID, t);
      f.parts.extra = { closeTrace: t };
      f.sync();
    },
  ],
  [
    "close linked to a later HTTP receiver",
    (f) => {
      const p = f.parts["fresh-ready"],
        later = f.parts["later-view"];
      p.close.references[0].traceID = later.trace.traceID;
      p.close.references[0].spanID = later.ui.spanID;
      f.sync();
    },
  ],
  [
    "wrong initialize Agent",
    (f) =>
      setTag(f.parts["fresh-ready"].initialize, "antnest.agent.id", "foreign"),
  ],
  [
    "wrong initializer parent",
    (f) =>
      (f.parts["fresh-ready"].initialize.references[0].spanID =
        f.parts["fresh-ready"].upstream.spanID),
  ],
  [
    "later GET from another Principal",
    (f) =>
      (f.evidence.http.find(
        (r) => r.label === "peer-login",
      ).body.principal.user_id = "other"),
  ],
  [
    "later GET from another organization",
    (f) =>
      (f.evidence.http.find(
        (r) => r.label === "peer-login",
      ).body.principal.organization_id = "other"),
  ],
  [
    "later GET from another Agent",
    (f) =>
      (f.parts["later-view"].row.path = f.parts["later-view"].row.path.replace(
        "/agents/agent/",
        "/agents/foreign/",
      )),
  ],
  [
    "later GET under a foreign UI process",
    (f) =>
      (f.parts["later-view"].trace.processes.ui.tags.find(
        (v) => v.key === "host.name",
      ).value = "foreign"),
  ],
  [
    "later GET under a foreign ACP process",
    (f) =>
      (f.parts["later-view"].trace.processes.acp.tags.find(
        (v) => v.key === "service.instance.id",
      ).value = "foreign"),
  ],
  [
    "cross-generation epoch reuse",
    (f) => (f.parts["prep-view"].row.body.bridgeEpoch = "new-ui-epoch"),
  ],
  [
    "inconsistent epoch after restart",
    (f) => (f.parts["later-view"].row.body.bridgeEpoch = "other-epoch"),
  ],
  [
    "missing successful-view epoch",
    (f) => delete f.parts["later-view"].row.body.bridgeEpoch,
  ],
  [
    "HTTP origin during restart",
    (f) => {
      f.parts["later-view"].row.started_at = 2500;
      f.parts["later-view"].row.at = 2520;
    },
  ],
  [
    "later GET after owner retirement",
    (f) => (f.parts["later-view"].ui.startTime = 7950 * 1000),
  ],
  [
    "overlapping same-scope owners",
    (f) => {
      f.owner(
        f.request(
          "overlap",
          5000,
          f.login("overlap-login", 4900),
          "/api/app/workspace/v1/agents/agent/view",
        ),
        7000,
      );
      f.sync();
    },
  ],
  [
    "unobserved private HTTP origin",
    (f) =>
      f.evidence.http.splice(
        f.evidence.http.indexOf(f.parts["later-view"].row),
        1,
      ),
  ],
  [
    "duplicate actual HTTP observation",
    (f) => f.evidence.http.push(structuredClone(f.parts["later-view"].row)),
  ],
  [
    "missing prep epoch witness",
    (f) =>
      f.evidence.http.splice(
        f.evidence.http.indexOf(f.parts["prep-view"].row),
        1,
      ),
  ],
  [
    "prep witness uses another Session",
    (f) =>
      (f.parts["prep-view"].row.path = f.parts["prep-view"].row.path.replace(
        "/sessions/session/",
        "/sessions/other/",
      )),
  ],
  [
    "403 origin without its actual recovery observation",
    (f) => delete f.evidence.recovery.cases[0].restored_state,
  ],
  [
    "403 origin with another credential",
    (f) => (f.parts["restored-denial"].row.credential_scope = "foreign"),
  ],
  [
    "403 without exact denial event",
    (f) => (f.parts["restored-denial"].ui.logs = []),
  ],
  [
    "403 with another denial cause",
    (f) =>
      (f.parts["restored-denial"].ui.logs[0].fields.find(
        (v) => v.key === "causes",
      ).value = '["unknown"]'),
  ],
  [
    "403 with duplicate event fields",
    (f) =>
      f.parts["restored-denial"].ui.logs[0].fields.push({
        key: "stage",
        value: "view",
      }),
  ],
  [
    "missing successful execution watch",
    (f) => {
      const p = f.parts["restored-denial"];
      p.trace.spans.splice(p.trace.spans.indexOf(p.streams[1]), 1);
    },
  ],
  [
    "watch bound to another organization",
    (f) =>
      setTag(
        f.parts["fresh-ready"].streams[1],
        "antnest.organization.id",
        "foreign",
      ),
  ],
  [
    "private GET with an invented Link",
    (f) =>
      f.parts["later-view"].streams[0].references.push({
        refType: "FOLLOWS_FROM",
        traceID: f.parts["fresh-ready"].trace.traceID,
        spanID: f.parts["fresh-ready"].ui.spanID,
      }),
  ],
  ["unsearched close", (f) => f.cleanupSearches.found.close.pop()],
  [
    "DELETE with the wrong close parent",
    (f) => {
      f.parts["fresh-ready"].closeTrace.spans[1].references = [];
      f.sync();
    },
  ],
])
  test(`owner inventory rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  });

test("a successful extra GET remains bound to the same owner rather than being silently omitted", () => {
  const f = fixture(),
    p = f.parts["later-view"],
    extra = f.addStream(p);
  const result = check(f),
    owner = result.owners.find(
      (o) => o.origin_trace_id === f.parts["fresh-ready"].trace.traceID,
    );
  assert(
    owner.streams.some(
      (s) => s.trace_id === p.trace.traceID && s.span_id === extra.spanID,
    ),
  );
  assert.equal(result.owners.length, 3);
});
