import assert from "node:assert/strict";
import { inspectHTTPTrace } from "./evidence.mjs";
import { owningServer, tag } from "./trace-tree.mjs";
import { inspectObservabilityResolution } from "./resolve-evidence.mjs";

export function inspectEgressDatabaseTrace(
  trace,
  values,
  expected,
  collection,
) {
  assert.equal(expected.profile, "console");
  assert.equal(expected.method, "PUT");
  assert.equal(expected.status, 200);
  assert.equal(
    expected.consoleRoute,
    "/api/admin/agents/{agent_id}/network-policy",
  );
  const resolution = inspectObservabilityResolution(
    trace,
    expected,
    collection,
  );
  const summary = inspectHTTPTrace(trace, {
    rootService: "edge-gateway",
    route: "/api/admin/{path...}",
    status: 200,
    captureRpcContent: collection.captureRpcContent,
    hops: [
      ...(resolution.source === "rpc"
        ? [["edge-gateway", "identity-service", 1]]
        : []),
      ["edge-gateway", "admin-console", 1],
      ["admin-console", "agent-controller", 1],
      ["agent-controller", "antnest-runtime-egress", 1],
    ],
  });
  const { server, database } = owningServer(trace, {
    service: "antnest-runtime-egress",
    clientService: "agent-controller",
    method: "PUT",
    route: "/internal/agent-policy-assignments/{agent_id}",
    status: 200,
  });
  const spans = trace.spans.filter(
    (span) =>
      trace.processes[span.processID].serviceName ===
        "antnest-runtime-egress" &&
      tag(span, "db.system.name") === "postgresql",
  );
  const transactions = spans.filter(
    (span) => span.operationName === "postgresql transaction",
  );
  assert.equal(transactions.length, 1);
  const transaction = transactions[0];
  assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
  assert(
    transaction.references.some(
      (ref) => ref.refType === "CHILD_OF" && ref.spanID === server.spanID,
    ),
  );
  const queries = spans.filter((span) => tag(span, "span.kind") === "client");
  assert.deepEqual(
    queries
      .toSorted((a, b) => a.startTime - b.startTime)
      .map((span) => span.operationName),
    [
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "BEGIN",
      "SELECT",
      "SELECT",
      "SELECT",
      "COMMIT",
    ],
  );
  assert.equal(database.length, 7);
  const inTransaction = queries.filter((span) =>
    span.references.some(
      (ref) => ref.refType === "CHILD_OF" && ref.spanID === transaction.spanID,
    ),
  );
  assert.deepEqual(
    inTransaction
      .toSorted((a, b) => a.startTime - b.startTime)
      .map((span) => span.operationName),
    ["BEGIN", "SELECT", "SELECT", "SELECT", "COMMIT"],
  );
  for (const span of spans) {
    assert.equal(tag(span, "db.namespace"), values.database);
    assert.equal(typeof tag(span, "server.address"), "string");
    assert.equal(typeof tag(span, "server.port"), "number");
  }
  for (const span of queries) {
    assert.equal(span.operationName, tag(span, "db.operation.name"));
    assert.notEqual(tag(span, "error"), true);
    assert(
      span.references.some(
        (ref) =>
          ref.refType === "CHILD_OF" && ref.spanID === transaction.spanID,
      ) ||
        (!inTransaction.includes(span) &&
          span.references.some(
            (ref) => ref.refType === "CHILD_OF" && ref.spanID === server.spanID,
          )),
    );
  }
  return {
    ...summary,
    gateway_resolution: resolution,
    egress_sql: queries.length,
    transaction_primitives: inTransaction.length,
    transactions: 1,
    policy_unchanged: true,
  };
}
