import assert from "node:assert/strict";
import { inspectHTTPTrace } from "./evidence.mjs";
import { owningServer, tag, traceTree } from "./trace-tree.mjs";
import { assertSuccessfulSpan } from "./successful-span.mjs";
import { inspectObservabilityResolution } from "./resolve-evidence.mjs";

export function inspectLocalAdminLogin(trace, stage, options = {}) {
  try {
    if (stage === "session")
      return inspectSessionTrace(trace, options.expected, options.collection);
    return inspectLoginTrace(trace, stage, options);
  } catch {
    // Assertions and JSON parse errors may retain raw RPC bodies.
    throw new Error("local admin trace validation failed");
  }
}

function inspectLoginTrace(trace, stage, options) {
  assert.equal(stage, "login", "unsupported login stage");
  const route = "/api/session/login";
  const rpcRoute = "/rpc/identity/local-login";
  const result = inspectHTTPTrace(trace, {
    rootService: "edge-gateway",
    route,
    status: 200,
    hops: [["edge-gateway", "identity-service", 1]],
    captureRpcContent: options.captureRpcContent,
  });
  const { service, parent } = traceTree(trace);
  assert.deepEqual(result.services, ["edge-gateway", "identity-service"]);
  const { server, client, database } = owningServer(trace, {
    service: "identity-service",
    clientService: "edge-gateway",
    method: "POST",
    route: rpcRoute,
    rpcMethod: "local_login",
    status: 200,
  });
  const root = parent(client);
  assert(root && !parent(root), "Gateway must be the root");
  assert.equal(service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.route"), route);
  assert.equal(tag(root, "http.request.method"), "POST");
  assert.equal(tag(client, "http.response.status_code"), 200);
  assert.equal(tag(client, "server.address"), "identity-service");
  const transactions = trace.spans.filter(
    (s) => s.operationName === "postgresql transaction",
  );
  assert.equal(transactions.length, 1);
  const transaction = transactions[0];
  if (transaction) {
    assert(parent(transaction) === server, "transaction has wrong owner");
    assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
    const outside = database.filter((s) => parent(s) === server);
    assert.equal(outside.length, 1);
    assert.equal(outside[0].operationName, "SELECT");
  }
  const expected = [
    "BEGIN",
    "COMMIT",
    "INSERT",
    "INSERT",
    "SELECT",
    "SELECT",
    "SELECT",
    "SELECT",
  ];
  assert.deepEqual(database.map((s) => s.operationName).sort(), expected);
  for (const span of database) {
    assert(
      [server, transaction].filter(Boolean).includes(parent(span)),
      "SQL has unexpected parent",
    );
  }
  const allowed = new Set([root, client, server, ...transactions, ...database]);
  assert.equal(
    trace.spans.length,
    allowed.size,
    "extra spans outside login flow",
  );
  assert.equal(
    result.diagnostic_events,
    2,
    "receiving RPC request/response evidence required",
  );
  for (const span of trace.spans)
    assertSuccessfulSpan(span, { rpcContent: span === server });
  return {
    ...result,
    stage,
    errors: 0,
    database_spans: database.length,
    transactions: transactions.length,
    transaction_sql: database.filter(
      (s) => transaction && parent(s) === transaction,
    ).length,
    chain: [root, client, server, ...transactions, ...database].map((span) => ({
      span_id: span.spanID,
      parent_span_id: parent(span)?.spanID ?? null,
      service: service(span),
      operation: span.operationName,
      kind: tag(span, "span.kind"),
      duration_ms: span.duration / 1000,
    })),
  };
}

function inspectSessionTrace(trace, expected, collection) {
  assert.equal(expected.profile, "session");
  const resolution = inspectObservabilityResolution(
    trace,
    expected,
    collection,
  );
  const result = inspectHTTPTrace(trace, {
    rootService: "edge-gateway",
    route: "/api/session",
    status: 200,
    captureRpcContent: collection.captureRpcContent,
    hops:
      resolution.source === "rpc"
        ? [["edge-gateway", "identity-service", 1]]
        : [],
  });
  const { service, parent } = traceTree(trace);
  return {
    ...result,
    stage: "session",
    errors: 0,
    transactions: 0,
    transaction_sql: 0,
    database_spans: resolution.database_spans,
    current_database_spans:
      resolution.source === "rpc" ? resolution.database_spans : 0,
    resolution_diagnostic_events:
      resolution.rpc_client_span_id && collection.captureRpcContent ? 2 : 0,
    gateway_resolution: resolution,
    chain: trace.spans.map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      parent_span_id: parent(span)?.spanID ?? null,
      service: service(span),
      operation: span.operationName,
      kind: tag(span, "span.kind"),
      duration_ms: span.duration / 1000,
    })),
  };
}
