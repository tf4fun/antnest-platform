import assert from "node:assert/strict";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { inspectWorkspaceRequestResolution } from "../workspace-closeout/request-trace.mjs";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import { resolveTraceDiagnostics } from "../../support/gateway-resolution-evidence.mjs";
import { inspectOrganizationRefresh } from "../identity-closeout/organization-freshness.mjs";

const one = (rows, label) => {
  assert.equal(rows.length, 1, `missing or duplicate ${label}`);
  return rows[0];
};
const key = (trace, span) => `${trace.traceID}:${span.spanID}`;

export function inspectLoadWire(wire) {
  assert.match(
    wire.upgrade?.trace_id ?? "",
    /^[a-f0-9]{32}$/u,
    "actual upgrade Trace missing",
  );
  assert.equal(wire.upgrade.status, 101);
  assert(
    [wire.started_at, wire.upgrade.at, wire.completed_at].every(
      Number.isFinite,
    ),
  );
  assert(
    wire.started_at <= wire.upgrade.at && wire.upgrade.at <= wire.completed_at,
    "invalid dial/upgrade interval",
  );
  assert(
    wire.completed_at - wire.started_at <= 8000,
    "100 exchanges including handshake exceeded eight seconds",
  );
  const requests = [],
    pending = new Map();
  let previous = wire.upgrade.at;
  for (const frame of wire.frames) {
    assert(
      Number.isFinite(frame.at) &&
        frame.at >= previous &&
        frame.at <= wire.completed_at,
      "frame outside elapsed window",
    );
    previous = frame.at;
    const message = JSON.parse(frame.raw);
    assert.equal(message.jsonrpc, "2.0");
    assert(
      ["string", "number"].includes(typeof message.id),
      "load must use request/reply exchanges",
    );
    const id = JSON.stringify(message.id);
    if (frame.direction === "send") {
      assert.equal(pending.size, 0, "load exchanges must be sequential");
      assert(!requests.some((row) => row.id === id), "duplicate request ID");
      assert.equal(
        message.method,
        requests.length === 0 ? "initialize" : "session/list",
      );
      if (requests.length === 0)
        assert.equal(message.params.protocolVersion, 1);
      else assert.deepEqual(message.params, {});
      const row = { id, requestId: String(message.id), method: message.method };
      requests.push(row);
      pending.set(id, row);
    } else {
      assert.equal(frame.direction, "receive");
      const row = pending.get(id);
      assert(row, "unmatched/duplicate actual reply");
      assert.equal(message.error, undefined, "load RPC failed");
      assert(message.result && typeof message.result === "object");
      if (row.method === "initialize")
        assert.equal(message.result.protocolVersion, 1);
      else
        assert(
          Array.isArray(message.result.sessions),
          "invalid session/list response",
        );
      pending.delete(id);
    }
  }
  assert.equal(pending.size, 0, "missing actual reply");
  assert.equal(
    requests.length,
    101,
    "initialize and 100 real list exchanges required",
  );
  return requests;
}

// The collection contains the actual connection, all its messages, and every
// independently discovered refresh linked to those requests. CLIENT attempts
// and receiving SERVERs are counted separately before exact pairing, so a
// failed attempt without a receiving SERVER cannot disappear from the count.
export function inspectResolveLoad(
  wire,
  agentID,
  settings,
  collection,
  secrets = [],
) {
  assert.equal(settings.resolveTTLMS, 10000, "load must use default TTL");
  assert.equal(settings.captureRpcContent, false);
  const messages = inspectLoadWire(wire);
  const { traces, archivedTraceIDs } = collection;
  const connection = traces.get(wire.upgrade.trace_id);
  assert(connection, "actual upgrade trace missing");
  const requests = new Map(),
    refreshes = [],
    clients = [],
    servers = [];
  for (const [id, trace] of traces) {
    assert.equal(trace.traceID, id);
    assert(archivedTraceIDs.has(id), "raw load source not archived");
    const tree = traceTopology(trace);
    assertCaptureDisabled(trace);
    assertGatewayResolutionAttributes(trace);
    assertSecretFree(JSON.stringify(trace), secrets);
    const root = one(
      trace.spans.filter((span) => !tree.parent(span)),
      "complete load root",
    );
    assert.equal(tree.service(root), "edge-gateway");
    for (const span of trace.spans) {
      assert(
        Number.isFinite(span.startTime) &&
          Number.isFinite(span.duration) &&
          span.duration >= 0,
        "unfinished load span",
      );
      // Resolve CLIENT identification uses its own service/kind/name and causal
      // root, never the presence of a successful downstream receipt.
      if (
        tree.service(span) === "edge-gateway" &&
        tag(span, "span.kind") === "client" &&
        tag(span, "http.request.method") === "POST" &&
        span.operationName === "HTTP POST identity-service"
      )
        clients.push({ trace, span, tree });
      if (
        tree.service(span) === "identity-service" &&
        tag(span, "span.kind") === "server" &&
        tag(span, "http.route") === "/rpc/identity/resolve-access-token"
      )
        servers.push({ trace, span, tree });
    }
    if (trace === connection) {
      assert.equal(tag(root, "span.kind"), "server");
      assert.equal(tag(root, "http.request.method"), "GET");
      assert.equal(
        tag(root, "http.route"),
        "/api/app/agents/{agent_id}/v1/acp",
      );
      assert.equal(tag(root, "http.response.status_code"), 101);
      const receipt = one(
        trace.spans.filter(
          (span) =>
            tree.service(span) === "agent-acp-service" &&
            tag(span, "span.kind") === "server" &&
            tag(span, "http.route") === "/v1/acp",
        ),
        "actual upstream upgrade",
      );
      assert.equal(tag(receipt, "http.response.status_code"), 101);
      const upstream = tree.parent(receipt);
      assert.equal(tree.service(upstream), "edge-gateway");
      assert.equal(tag(upstream, "span.kind"), "client");
      assert.equal(tree.parent(upstream), root);
      const decisions = trace.spans.filter(
        (span) => span.operationName === "gateway.identity.resolve",
      );
      const initial = one(
        decisions.filter((span) => span.startTime < upstream.startTime),
        "initial admission",
      );
      for (const decision of decisions)
        inspectGatewayResolution(
          trace,
          {
            rootSpanID: root.spanID,
            decisionSpanID: decision.spanID,
            profile: "acp",
            ttlMs: settings.resolveTTLMS,
            ...(decision === initial
              ? { upstreamSpanID: upstream.spanID }
              : {}),
          },
          collection,
        );
    } else if (root.operationName === "gateway.identity.resolve.refresh") {
      refreshes.push({ trace, root, tree });
    } else {
      const request = one(
        trace.spans.filter(
          (span) =>
            tree.service(span) === "agent-acp-service" &&
            tag(span, "span.kind") === "server",
        ),
        "actual ACP request",
      );
      const requestId = tag(request, "antnest.request.id");
      assert(!requests.has(requestId), "duplicate message trace");
      const message = messages.find((row) => row.requestId === requestId);
      assert(message, "unexpected ACP message trace");
      const expected = {
        ...message,
        kind: "request",
        transport: "websocket",
        agentId: agentID,
        connectionTraceID: wire.upgrade.trace_id,
        resolveTTLMS: settings.resolveTTLMS,
      };
      inspectWorkspaceRequestResolution(trace, expected, secrets, collection);
      inspectCommandTrace(trace, expected, secrets);
      requests.set(requestId, trace.traceID);
    }
  }
  assert.equal(requests.size, 101, "missing actual message traces");
  const causal = new Set([connection.traceID, ...requests.values()]);
  for (const { root, trace } of refreshes) {
    const link = one(
      root.references.filter((ref) => ref.refType === "FOLLOWS_FROM"),
      "refresh trigger link",
    );
    assert(causal.has(link.traceID), "foreign background trigger");
    inspectOrganizationRefresh(
      trace,
      {
        traceID: trace.traceID,
        triggerTraceID: link.traceID,
        triggerDecisionID: link.spanID,
        profile: "acp",
        ttlMS: settings.resolveTTLMS,
      },
      secrets,
      collection,
    );
  }
  assert(
    clients.length >= 1 && clients.length <= 3,
    "Gateway actual Resolve attempts exceed budget",
  );
  assert(
    servers.length >= 1 && servers.length <= 3,
    "Identity actual Resolve receipts exceed budget",
  );
  for (const client of clients) {
    assert.equal(tag(client.span, "http.response.status_code"), 200);
    const receipt = one(
      servers.filter(
        (row) =>
          row.trace === client.trace &&
          row.tree.parent(row.span) === client.span,
      ),
      "Identity receipt for actual CLIENT",
    );
    assert.equal(tag(receipt.span, "rpc.method"), "resolve_access_token");
    assert.equal(tag(receipt.span, "http.request.method"), "POST");
    assert.equal(tag(receipt.span, "http.response.status_code"), 200);
    databaseChildrenTopology(receipt.trace, receipt.span);
  }
  for (const receipt of servers)
    assert(
      clients.some(
        (row) =>
          row.trace === receipt.trace &&
          row.span === receipt.tree.parent(receipt.span),
      ),
      "unpaired Identity receipt",
    );
  for (const trace of traces.values())
    assert(!trace.spans.some(hasError), "unexpected load error");
  return {
    exchanges: 100,
    elapsed_ms: wire.completed_at - wire.started_at,
    message_traces: requests.size,
    gateway_rpc_attempts: clients.length,
    identity_rpc_receipts: servers.length,
    background_refreshes: refreshes.length,
    gateway_clients: clients.map(({ trace, span }) => key(trace, span)),
    identity_servers: servers.map(({ trace, span }) => key(trace, span)),
    ...resolveTraceDiagnostics(connection, [...traces.values()]),
  };
}
