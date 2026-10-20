import assert from "node:assert/strict";
import test from "node:test";
import { authorityFixture } from "./resolve-cache-outage-authority-fixtures.mjs";
import { inspectRecoveryAuthorityCase } from "./resolve-cache-recovery-authority.mjs";
import {
  setTag,
  resolvePrefix,
} from "../observability/gateway-resolution-fixtures.mjs";

function fixture() {
  const f = authorityFixture(),
    e = f.evidence;
  const initial = e.http.find((r) => r.label === "fresh-consumer-agent-ready");
  initial.path = "/api/app/workspace/v1/agents/agent/sessions/session/view";
  const source = f.fixtures.workspaceSource;
  setTag(source.root, "http.route", "/api/app/workspace/v1/{path...}");
  setTag(source.upstream, "http.request.method", "GET");
  source.trace.processes.consumer.serviceName = "agent-ui";
  const receiver = source.trace.spans.find((s) => s.spanID === "receiver");
  setTag(receiver, "http.request.method", "GET");
  setTag(receiver, "http.route", "/api/app/workspace/v1/*");
  const c = {
    name: "logout",
    login: e.http.find((r) => r.label === "warm-login"),
    initial_view: initial,
    wire: e.wire,
    stream: e.stream,
    session_id: "session",
    wss_close: { observed_at: 2000 },
    trigger: { at: 1800 },
  };
  c.stream.closure = { at: 2001 };
  return { ...f, c };
}
const check = (f) => inspectRecoveryAuthorityCase(f.evidence, f.c, f);
test("recovery remote retirement precedes the original WSS and SSE conservative authority bounds", () => {
  const result = check(fixture());
  assert(result.wss.conservative_deadline > 2000);
  assert(result.sse.conservative_deadline > 2001);
});
for (const [name, change] of [
  [
    "initialize send after its reply",
    (f) => {
      f.c.wire.frames[0].at = f.c.wire.frames[1].at + 1;
    },
  ],
  [
    "initialize reply after mutation",
    (f) => {
      f.c.wire.frames[1].at = f.c.trigger.at + 1;
    },
  ],
  [
    "wrong original forwarding status",
    (f) =>
      setTag(f.fixtures.connection.upstream, "http.response.status_code", 503),
  ],
  [
    "wrong forwarding method",
    (f) => setTag(f.fixtures.sse.upstream, "http.request.method", "POST"),
  ],
  [
    "SQL error type without status",
    (f) =>
      setTag(
        f.fixtures.connection.trace.spans.find((s) => s.spanID === "sql"),
        "error.type",
        "database_error",
      ),
  ],
  [
    "SQL numeric error status",
    (f) =>
      setTag(
        f.fixtures.connection.trace.spans.find((s) => s.spanID === "sql"),
        "otel.status_code",
        2,
      ),
  ],
  [
    "closure exactly at original WSS bound",
    (f) => {
      f.c.wss_close.observed_at = check(f).wss.conservative_deadline;
    },
  ],
  [
    "closure after original SSE bound",
    (f) => {
      f.c.stream.closure.at = check(f).sse.conservative_deadline + 1;
    },
  ],
  [
    "SSE admitted using other credential",
    (f) => {
      f.c.stream.credential_scope = "other";
    },
  ],
  [
    "view from another credential",
    (f) => {
      f.c.initial_view.credential_scope = "other";
    },
  ],
  [
    "wrong original Resolve age",
    (f) =>
      setTag(
        f.fixtures.initialize.decision,
        resolvePrefix + "snapshot_age_ms",
        1,
      ),
  ],
  [
    "initialize uses new RPC authority",
    (f) =>
      setTag(f.fixtures.initialize.decision, resolvePrefix + "source", "rpc"),
  ],
  [
    "wrong WSS connection",
    (f) => {
      f.fixtures.initialize.root.references[0].traceID = "e".repeat(32);
    },
  ],
  [
    "failed original SQL",
    (f) =>
      setTag(
        f.fixtures.connection.trace.spans.find((s) => s.spanID === "sql"),
        "error",
        true,
      ),
  ],
  [
    "failed actual initialize response",
    (f) => {
      const reply = f.c.wire.frames.find((r) => r.direction === "receive");
      reply.raw = '{"jsonrpc":"2.0","id":0,"error":{"code":-1}}';
    },
  ],
  [
    "ambiguous original RPC",
    (f) => {
      const t = structuredClone(f.fixtures.connection.trace),
        id = "e".repeat(32);
      t.traceID = id;
      for (const s of t.spans) {
        s.traceID = id;
        for (const r of s.references) r.traceID = id;
      }
      f.traces.set(id, t);
      f.archivedTraceIDs.add(id);
    },
  ],
])
  test(`recovery authority rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  });

function bridgeFixture() {
  const f = authorityFixture(4),
    e = f.evidence;
  const source = f.fixtures.workspaceSource;
  // A recovery owner may already exist. Session creation is the new Cookie's
  // actual RPC source; neither a new initialize nor a WSS connection is needed.
  source.trace.spans = source.trace.spans.filter(
    (s) => s !== source.initialize,
  );
  delete source.initialize;
  for (const span of [
    source.root,
    source.upstream,
    source.trace.spans.find((s) => s.spanID === "receiver"),
  ]) {
    setTag(span, "http.request.method", "POST");
    setTag(span, "http.response.status_code", 201);
  }
  const created = e.http.find((r) => r.label === "fresh-consumer-agent-ready");
  Object.assign(created, {
    method: "POST",
    status: 201,
    path: "/api/app/workspace/v1/agents/agent/sessions",
    request: {},
    body: { sessionId: "session" },
  });
  const initial = e.http.find((r) => r.label === "warm-workspace-hit");
  Object.assign(initial, {
    started_at: 1400,
    at: 1410,
    body: { agentId: "agent", sessionId: "session" },
  });
  const hit = f.fixtures.workspaceHit;
  for (const span of hit.trace.spans) span.startTime -= 200000;
  for (const key of ["snapshot_age_ms", "proof_age_ms"])
    setTag(
      hit.decision,
      resolvePrefix + key,
      hit.decision.tags.find((t) => t.key === resolvePrefix + key).value - 200,
    );
  const valid = hit.decision.tags.find(
    (t) => t.key === resolvePrefix + "valid_for_ms",
  ).value;
  setTag(hit.decision, resolvePrefix + "valid_for_ms", valid + 200);
  const login = e.http.find((r) => r.label === "warm-login");
  login.body = {
    principal: {
      user_id: "owner",
      organization_id: "organization",
      membership_id: "member",
      active: true,
    },
  };
  const c = {
    name: "logout",
    agent_id: "agent",
    owner_id: "owner",
    login,
    session_create: created,
    initial_view: initial,
    stream: e.stream,
    session_id: "session",
    trigger: { at: 1800 },
  };
  c.stream.closure = {
    kind: "transport-end",
    at: 2001,
    trace_id: c.stream.trace_id,
  };
  return { ...f, c };
}

test("Bridge recovery binds both cache admissions to actual session creation without a new initialize", () => {
  const f = bridgeFixture(),
    result = check(f);
  assert.equal(result.view_trace_id, f.c.initial_view.trace_id);
  assert.equal(result.sse_trace_id, f.c.stream.trace_id);
  assert.equal(result.session_create_trace_id, f.c.session_create.trace_id);
  for (const key of ["view", "sse"]) {
    assert.equal(result[key].source_trace_id, f.c.session_create.trace_id);
    assert(result[key].conservative_deadline > f.c.stream.closure.at);
  }
  assert.equal(result.wss, undefined);
});

for (const [name, change] of [
  [
    "unknown revision",
    (f) => {
      f.evidence.policy_revision = 5;
    },
  ],
  [
    "Bridge payload with legacy revision",
    (f) => {
      f.evidence.policy_revision = 3;
    },
  ],
  [
    "missing transport",
    (f) => {
      delete f.evidence.transport;
    },
  ],
  [
    "retired WSS payload",
    (f) => {
      f.c.wire = {};
    },
  ],
  [
    "retired WSS closure",
    (f) => {
      f.c.wss_close = {};
    },
  ],
  [
    "foreign session creation Cookie",
    (f) => {
      f.c.session_create.credential_scope = "foreign";
    },
  ],
  [
    "foreign initial view Cookie",
    (f) => {
      f.c.initial_view.credential_scope = "foreign";
    },
  ],
  [
    "foreign stream Cookie",
    (f) => {
      f.c.stream.credential_scope = "foreign";
    },
  ],
  [
    "foreign creation Agent",
    (f) => {
      f.c.session_create.path = "/api/app/workspace/v1/agents/other/sessions";
    },
  ],
  [
    "foreign creation Session",
    (f) => {
      f.c.session_create.body.sessionId = "other";
    },
  ],
  [
    "foreign view Agent",
    (f) => {
      f.c.initial_view.body.agentId = "other";
    },
  ],
  [
    "foreign view Session",
    (f) => {
      f.c.initial_view.body.sessionId = "other";
    },
  ],
  [
    "foreign case Agent",
    (f) => {
      f.c.agent_id = "other";
    },
  ],
  [
    "foreign login Principal",
    (f) => {
      f.c.login.body.principal.user_id = "other";
    },
  ],
  [
    "foreign stream Session",
    (f) => {
      f.c.stream.path =
        "/api/app/workspace/v1/agents/agent/events?sessionId=other";
    },
  ],
  [
    "forged creation receipt",
    (f) => {
      f.c.session_create = { ...f.c.session_create, at: 1090 };
    },
  ],
  [
    "GET in place of creation POST",
    (f) => {
      f.c.session_create.method = "GET";
    },
  ],
  [
    "200 in place of creation 201",
    (f) => {
      f.c.session_create.status = 200;
    },
  ],
  [
    "wrong original raw method",
    (f) => {
      setTag(f.fixtures.workspaceSource.upstream, "http.request.method", "GET");
    },
  ],
  [
    "wrong original raw status",
    (f) => {
      setTag(f.fixtures.workspaceSource.root, "http.response.status_code", 200);
    },
  ],
  [
    "original RPC SQL error",
    (f) => {
      setTag(
        f.fixtures.workspaceSource.trace.spans.find((s) => s.spanID === "sql"),
        "error",
        true,
      );
    },
  ],
  [
    "missing original SQL",
    (f) => {
      f.fixtures.workspaceSource.trace.spans =
        f.fixtures.workspaceSource.trace.spans.filter(
          (s) => s.spanID !== "sql",
        );
    },
  ],
  [
    "unarchived original source",
    (f) => {
      f.archivedTraceIDs.delete(f.c.session_create.trace_id);
    },
  ],
  [
    "foreign original parent",
    (f) => {
      f.fixtures.workspaceSource.trace.spans.find(
        (s) => s.spanID === "receiver",
      ).references[0].spanID = "absent";
    },
  ],
  [
    "wrong original snapshot age",
    (f) => {
      setTag(
        f.fixtures.workspaceHit.decision,
        resolvePrefix + "snapshot_age_ms",
        1,
      );
    },
  ],
  [
    "view replaced by later RPC",
    (f) => {
      setTag(f.fixtures.workspaceHit.decision, resolvePrefix + "source", "rpc");
    },
  ],
  [
    "local stream shutdown",
    (f) => {
      f.c.stream.closure.kind = "local-close";
    },
  ],
  [
    "missing actual closure Trace",
    (f) => {
      delete f.c.stream.closure.trace_id;
    },
  ],
  [
    "another stream's closure",
    (f) => {
      f.c.stream.closure.trace_id = f.c.initial_view.trace_id;
    },
  ],
  [
    "closure before revocation",
    (f) => {
      f.c.stream.closure.at = f.c.trigger.at - 1;
    },
  ],
  [
    "closure exactly at original view deadline",
    (f) => {
      f.c.stream.closure.at = check(f).view.conservative_deadline;
    },
  ],
  [
    "closure exactly at original SSE deadline",
    (f) => {
      f.c.stream.closure.at = check(f).sse.conservative_deadline;
    },
  ],
  [
    "view before creation finished",
    (f) => {
      f.c.initial_view.started_at = f.c.session_create.at - 1;
    },
  ],
  [
    "stream before view finished",
    (f) => {
      f.c.stream.started_at = f.c.initial_view.at - 1;
    },
  ],
])
  test(`Bridge recovery authority rejects ${name}`, () => {
    const f = bridgeFixture();
    change(f);
    assert.throws(
      () => check(f),
      (error) => error instanceof assert.AssertionError,
    );
  });
