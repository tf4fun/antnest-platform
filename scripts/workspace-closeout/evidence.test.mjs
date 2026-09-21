import assert from "node:assert/strict";
import test from "node:test";
import { databaseRequest, fields } from "../observability/trace-fixtures.mjs";
import {
  assertState,
  assertRevokedTransport,
  inspectStateTrace,
} from "./evidence.mjs";

test("revocation requires explicit policy closure or unauthorized upgrade, never timeout or server error", () => {
  assertRevokedTransport({ closeCode: 1008 }, "existing");
  assertRevokedTransport({ handshakeStatus: 401 }, "new");
  for (const [transport, kind] of [
    [{}, "existing"],
    [{ closeCode: 1006 }, "existing"],
    [{ closeCode: 1000 }, "existing"],
    [{}, "new"],
    [{ handshakeStatus: 500 }, "new"],
    [{ handshakeStatus: 101 }, "new"],
  ]) {
    assert.throws(() => assertRevokedTransport(transport, kind));
  }
});

const ready = {
  agent_id: "a1",
  availability: "ready",
  access_allowed: true,
  configuration_revision: "a".repeat(64),
  unavailable_reason: null,
  active_session_id: null,
};
test("state evidence rejects leaked fields, another Agent and impossible readiness", () => {
  assertState(ready, "a1");
  for (const value of [
    { ...ready, secret: "private" },
    { ...ready, agent_id: "a2" },
    { ...ready, agent_revision: 0 },
    { ...ready, active_session_id: "s1" },
    { ...ready, access_allowed: false },
  ]) {
    assert.throws(() => assertState(value, "a1"));
  }
});

function fixture() {
  const traceID = "a".repeat(32);
  const processes = Object.fromEntries(
    ["edge-gateway", "identity-service", "agent-controller"].map((name) => [
      name,
      { serviceName: name },
    ]),
  );
  const make = (spanID, processID, operationName, parent) => ({
    spanID,
    processID,
    operationName,
    traceID,
    references: parent
      ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
      : [],
    tags: [],
  });
  const result = {
    traceID,
    processes,
    spans: [
      make(
        "1",
        "edge-gateway",
        "HTTP GET /api/app/agents/{agent_id}/state/watch",
      ),
      make("2", "edge-gateway", "HTTP POST identity-service", "1"),
      make("3", "identity-service", "HTTP POST /internal/rpc", "2"),
      make("4", "edge-gateway", "HTTP GET agent-controller", "1"),
      make(
        "5",
        "agent-controller",
        "HTTP GET /internal/workspace/agents/{agent_id}/state/watch",
        "4",
      ),
      make("6", "agent-controller", "SELECT", "5"),
    ],
  };
  result.spans[0].tags = [
    { key: "http.request.method", value: "GET" },
    { key: "span.kind", value: "server" },
    { key: "http.route", value: "/api/app/agents/{agent_id}/state/watch" },
  ];
  result.spans[1].tags = [
    { key: "span.kind", value: "client" },
    { key: "rpc.method", value: "/rpc/identity/resolve-access-token" },
  ];
  result.spans[3].tags = [
    { key: "span.kind", value: "client" },
    { key: "http.request.method", value: "GET" },
  ];
  Object.assign(
    result.spans[2],
    databaseRequest(
      traceID,
      "3",
      "2",
      "identity-service",
      "/rpc/identity/resolve-access-token",
      "POST",
      "resolve_access_token",
    )[0],
  );
  result.spans.push(
    databaseRequest(
      traceID,
      "3",
      "2",
      "identity-service",
      "/rpc/identity/resolve-access-token",
      "POST",
      "resolve_access_token",
    )[1],
  );
  result.spans[4].tags = fields({
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "/internal/workspace/agents/{agent_id}/state/watch",
  });
  result.spans[5].duration = 1;
  result.spans[5].tags = fields({
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.query.text": "SELECT $1",
    "db.operation.name": "SELECT",
  });
  return result;
}

test("trace evidence requires matching dependency ancestry, not service-name co-occurrence", () => {
  assert.equal(inspectStateTrace(fixture(), []).gateway_ancestry, true);
  const renamed = fixture();
  renamed.spans[0].operationName =
    "HTTP GET GET /api/app/agents/{agent_id}/state/watch";
  assert.equal(inspectStateTrace(renamed, []).gateway_ancestry, true);
  const wrongRoute = fixture();
  wrongRoute.spans[0].tags.find((tag) => tag.key === "http.route").value =
    "/unrelated";
  assert.throws(() => inspectStateTrace(wrongRoute, []));
  for (const index of [2, 4, 5]) {
    const trace = fixture();
    trace.spans[index].references = [];
    assert.throws(() => inspectStateTrace(trace, []));
  }
  for (const index of [2, 4]) {
    const trace = fixture();
    trace.spans[index].references[0].spanID = "1";
    assert.throws(() => inspectStateTrace(trace, []));
  }
  const leaked = fixture();
  leaked.spans[1].tags.push({ key: "secret", value: "cookie-canary" });
  assert.throws(() => inspectStateTrace(leaked, ["cookie-canary"]));
  for (const mutate of [
    (trace) => {
      trace.spans = trace.spans.filter((span) => span.spanID !== "6");
    },
    (trace) => {
      trace.spans.push({ ...trace.spans[4], spanID: "duplicate" });
    },
    (trace) => {
      trace.spans[4].warnings = ["clock skew warning"];
    },
  ]) {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectStateTrace(trace, []));
  }
});
