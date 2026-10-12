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
