import assert from "node:assert/strict";
import test from "node:test";
import * as implementation from "../edge-gateway/resolve-cache-recovery-http.mjs";
import { recoveryHTTPFixture } from "../edge-gateway/resolve-cache-recovery-http-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

function fixture() {
  const original = recoveryHTTPFixture();
  const p = original.parts.find((part) => part.action === "logout");
  const collection = {
    traces: new Map([[p.trace.traceID, p.trace]]),
    archivedTraceIDs: new Set([p.trace.traceID]),
  };
  const observation = {
    kind: "logout",
    path: "/api/session",
    method: "DELETE",
    status: 204,
    traceID: p.trace.traceID,
    credentialScope: "00000000-0000-4000-8000-000000000001",
    principal: { organization_id: "org", user_id: "user" },
  };
  return { p, collection, observation };
}
function inspect(f) {
  assert.equal(typeof implementation.inspectLogoutMutation, "function");
  return implementation.inspectLogoutMutation(
    f.p.trace,
    f.observation,
    f.collection,
    ["PRIVATE-TRACE-CANARY"],
  );
}
function remove(p, id) {
  p.trace.spans = p.trace.spans.filter((s) => s.spanID !== id);
}

test("standalone logout Trace binds the real HTTP command, one token revoke and committed feed without unrelated recovery cases", () => {
  const f = fixture();
  f.p.root.warnings = ["original diagnostic"];
  const raw = JSON.stringify(f.p.trace);
  const result = inspect(f);
  assert.equal(result.trace_id, f.p.trace.traceID);
  assert.equal(result.identity_server_span_id, f.p.server.spanID);
  assert.equal(result.transaction_span_id, f.p.transaction.spanID);
  assert.equal(result.commit_span_id, f.p.commit.spanID);
  assert.equal(result.revoked_sessions, 1);
  assert.equal(result.session_feed_rows, 1);
  assert.equal(result.resolution.profile, "session");
  assert.equal(result.warning_count, 1);
  assert.equal(result.strict_trace, "failed");
  assert.equal(JSON.stringify(f.p.trace), raw);
});

for (const [name, change] of [
  [
    "logout command after Gateway response completion",
    (f) => {
      f.p.root.duration =
        f.p.decision.startTime + f.p.decision.duration - f.p.root.startTime;
    },
  ],
  [
    "logout command in a different Gateway process",
    (f) => {
      f.p.trace.processes.otherGateway = { serviceName: "edge-gateway" };
      f.p.client.processID = "otherGateway";
    },
  ],
  ["unfinished logout command", (f) => delete f.p.client.duration],
  ["negative logout command duration", (f) => (f.p.client.duration = -1)],
  [
    "nonfinite logout command duration",
    (f) => (f.p.client.duration = Infinity),
  ],
  ["negative logout SQL duration", (f) => (f.p.revoked.duration = -1)],
  [
    "unfinished attached internal span",
    (f) => {
      const span = f.p.add("extra-internal", "edge", f.p.root, {
        "span.kind": "internal",
      });
      delete span.duration;
    },
  ],
  [
    "failure result in completion event",
    (f) => {
      f.p.server.logs.push({
        timestamp: f.p.server.startTime,
        fields: [
          { key: "event", value: "antnest.complete" },
          { key: "antnest.result", value: "failed" },
        ],
      });
    },
  ],
  [
    "conflicting SQL tags",
    (f) => {
      f.p.revoked.tags.push({
        key: "db.query.text",
        value: "DELETE FROM api_tokens",
      });
    },
  ],
  [
    "duplicate status tags",
    (f) => {
      f.p.server.tags.push({ key: "http.response.status_code", value: 500 });
    },
  ],
  [
    "conflicting admitted Resolve SQL tags",
    (f) => {
      f.p.trace.spans
        .find((s) => s.spanID === "sql")
        .tags.push({
          key: "db.query.text",
          value: "DELETE FROM api_tokens",
        });
    },
  ],
  [
    "failure result on logout SERVER",
    (f) => setTag(f.p.server, "antnest.result", "error"),
  ],
  [
    "failed result on logout SERVER",
    (f) => setTag(f.p.server, "antnest.result", "failed"),
  ],
  [
    "failed result on logout SQL",
    (f) => setTag(f.p.revoked, "antnest.result", "failed"),
  ],
  [
    "failure result on admitted Resolve SERVER",
    (f) =>
      setTag(
        f.p.trace.spans.find((s) => s.spanID === "resolve-server"),
        "antnest.result",
        "error",
      ),
  ],
  [
    "different HTTP trace",
    (f) => {
      f.observation.traceID = "f".repeat(32);
    },
  ],
  [
    "wrong HTTP method",
    (f) => {
      f.observation.method = "POST";
    },
  ],
  [
    "missing archive",
    (f) => {
      f.collection.archivedTraceIDs.clear();
    },
  ],
  [
    "missing Principal",
    (f) => {
      delete f.observation.principal;
    },
  ],
  ["missing COMMIT", (f) => remove(f.p, "commit")],
  ["missing revoke", (f) => remove(f.p, "revoked")],
  [
    "more than one revoked token",
    (f) => setTag(f.p.revoked, "pgx.rows_affected", 2),
  ],
  ["missing feed insert", (f) => remove(f.p, "session-feed-0")],
  ["missing feed lock", (f) => remove(f.p, "session-lock")],
  ["missing audit", (f) => remove(f.p, "audit")],
  [
    "unknown SQL write",
    (f) => setTag(f.p.revoked, "db.query.text", "DELETE FROM api_tokens"),
  ],
  [
    "write outside transaction",
    (f) => {
      f.p.revoked.references[0].spanID = f.p.server.spanID;
    },
  ],
  [
    "write after COMMIT",
    (f) => {
      f.p.revoked.startTime = f.p.commit.startTime + 1000;
    },
  ],
  [
    "foreign SQL process",
    (f) => {
      f.p.trace.processes.other = { serviceName: "identity-service" };
      f.p.revoked.processID = "other";
    },
  ],
  [
    "wrong Resolve profile",
    (f) =>
      setTag(f.p.decision, "antnest.identity.resolve.profile", "workspace"),
  ],
  [
    "failed admitted token SELECT",
    (f) =>
      setTag(
        f.p.trace.spans.find((s) => s.spanID === "sql"),
        "error",
        true,
      ),
  ],
  [
    "wrong admitted token SELECT",
    (f) =>
      setTag(
        f.p.trace.spans.find((s) => s.spanID === "sql"),
        "db.query.text",
        "SELECT 1",
      ),
  ],
  ["extra numeric error", (f) => setTag(f.p.root, "otel.status_code", 2)],
  [
    "extra exception event",
    (f) => {
      f.p.root.logs = [
        {
          timestamp: f.p.root.startTime,
          fields: [{ key: "event", value: "exception" }],
        },
      ];
    },
  ],
  [
    "private data",
    (f) => setTag(f.p.root, "unclassified", "PRIVATE-TRACE-CANARY"),
  ],
])
  test(`standalone logout cannot accept ${name}`, () => {
    const f = fixture();
    assert.equal(typeof implementation.inspectLogoutMutation, "function");
    change(f);
    assert.throws(() => inspect(f));
  });
