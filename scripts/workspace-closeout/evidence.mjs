import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertCaptureDisabled,
  databaseChildren,
  owningServer,
  traceTree,
  tag,
} from "../observability/trace-tree.mjs";

export function assertRevokedTransport(connection, kind) {
  if (kind === "existing")
    assert.equal(
      connection.closeCode,
      1008,
      "revoked connection requires policy closure",
    );
  else {
    assert.equal(kind, "new");
    assert(
      [401, 403].includes(connection.handshakeStatus),
      "new connection requires unauthorized upgrade",
    );
  }
}

export function assertState(state, agentID) {
  assert.deepEqual(Object.keys(state).sort(), [
    "access_allowed",
    "active_session_id",
    "agent_id",
    "agent_revision",
    "availability",
  ]);
  assert.equal(state.agent_id, agentID);
  assert(["ready", "busy", "offline"].includes(state.availability));
  assert.equal(typeof state.access_allowed, "boolean");
  assert(
    Number.isSafeInteger(state.agent_revision) && state.agent_revision > 0,
  );
  assert(
    state.active_session_id === null ||
      (typeof state.active_session_id === "string" &&
        state.active_session_id.trim()),
  );
  if (state.availability === "ready")
    assert.equal(state.active_session_id, null);
  if (!state.access_allowed) {
    assert.equal(state.availability, "offline");
    assert.equal(state.active_session_id, null);
  }
}

export function inspectStateTrace(trace, secrets) {
  const { service, chain: ancestry } = traceTree(trace);
  assertCaptureDisabled(trace);
  const roots = trace.spans.filter(
    (span) =>
      service(span) === "edge-gateway" &&
      tag(span, "http.request.method") === "GET" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.route") === "/api/app/agents/{agent_id}/state/watch",
  );
  assert.equal(roots.length, 1, "missing/duplicate Gateway state root");
  const root = roots[0];
  function chain(span) {
    const result = ancestry(span);
    assert(
      result.includes(root),
      "dependency detached from Gateway state request",
    );
    return result;
  }
  const identities = trace.spans.filter(
    (span) =>
      service(span) === "identity-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.route") === "/rpc/identity/resolve-access-token" &&
      tag(span, "http.request.method") === "POST",
  );
  assert(identities.length, "Identity revalidation missing");
  identities.forEach((span) => {
    assert.equal(tag(span, "rpc.method"), "resolve_access_token");
    databaseChildren(trace, span);
    const parent = chain(span)[1];
    assert(
      parent &&
        service(parent) === "edge-gateway" &&
        tag(parent, "span.kind") === "client" &&
        tag(parent, "rpc.method") === "/rpc/identity/resolve-access-token",
      "Identity SERVER must be parented by its HTTP CLIENT",
    );
    assert.equal(
      identities.filter((item) => ancestry(item)[1] === parent).length,
      1,
      "duplicate Identity request for one CLIENT",
    );
  });
  const { server, client, database } = owningServer(trace, {
    service: "agent-controller",
    method: "GET",
    route: "/internal/workspace/agents/{agent_id}/state/watch",
    clientService: "edge-gateway",
  });
  assert.equal(tag(client, "http.request.method"), "GET");
  chain(server);
  assertSecretFree(JSON.stringify(trace), secrets);
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    state_requests: 1,
    database_spans: database.length,
    capture_rpc_content: false,
    identity_checks: identities.length,
    gateway_ancestry: true,
  };
}
