import assert from "node:assert/strict";
import { inspectHTTPTrace } from "./evidence.mjs";
import { owningServer, tag, traceTree } from "./trace-tree.mjs";
import { assertSuccessfulSpan } from "./successful-span.mjs";

export function inspectLocalAdminLogin(trace, stage) {
  try {
    return inspectLoginTrace(trace, stage);
  } catch {
    // Assertions and JSON parse errors may retain raw RPC bodies.
    throw new Error("local admin trace validation failed");
  }
}

function inspectLoginTrace(trace, stage) {
  assert(["login", "session"].includes(stage), "unsupported login stage");
  const login = stage === "login";
  const route = login ? "/api/session/login" : "/api/session";
  const rpcRoute = `/rpc/identity/${login ? "local-login" : "resolve-access-token"}`;
  const result = inspectHTTPTrace(trace, {
    rootService: "edge-gateway",
    route,
    status: 200,
    hops: [["edge-gateway", "identity-service", 1]],
  });
  const { service, parent } = traceTree(trace);
  assert.deepEqual(result.services, ["edge-gateway", "identity-service"]);
  const { server, client, database } = owningServer(trace, {
    service: "identity-service",
    clientService: "edge-gateway",
    method: "POST",
    route: rpcRoute,
    rpcMethod: login ? "local_login" : "resolve_access_token",
    status: 200,
  });
  const root = parent(client);
  assert(root && !parent(root), "Gateway must be the root");
  assert.equal(service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.route"), route);
  assert.equal(tag(root, "http.request.method"), login ? "POST" : "GET");
  assert.equal(tag(client, "http.response.status_code"), 200);
  assert.equal(tag(client, "server.address"), "identity-service");
  const transactions = trace.spans.filter(
    (s) => s.operationName === "postgresql transaction",
  );
  assert.equal(transactions.length, login ? 1 : 0);
  const transaction = transactions[0];
  if (transaction) {
    assert(parent(transaction) === server, "transaction has wrong owner");
    assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
    const outside = database.filter((s) => parent(s) === server);
    assert.equal(outside.length, 1);
    assert.equal(outside[0].operationName, "SELECT");
  }
  const expected = login
    ? [
        "BEGIN",
        "COMMIT",
        "INSERT",
        "INSERT",
        "SELECT",
        "SELECT",
        "SELECT",
        "SELECT",
      ]
    : [
        "SELECT",
        // Identity samples last_used_at at most once per five minutes.
        ...(database.some((s) => s.operationName === "UPDATE")
          ? ["UPDATE"]
          : []),
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
