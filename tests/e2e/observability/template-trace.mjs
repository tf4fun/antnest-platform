import assert from "node:assert/strict";
import { inspectHTTPTrace } from "./evidence.mjs";
import { owningServer, tag } from "./trace-tree.mjs";
import { inspectObservabilityResolution } from "./resolve-evidence.mjs";

export function inspectTemplateTrace(trace, expected, collection) {
  assert.equal(expected.profile, "console");
  assert.equal(expected.method, "POST");
  assert.equal(expected.status, 201);
  assert.equal(expected.consoleRoute, "/api/admin/templates");
  const resolution = inspectObservabilityResolution(
    trace,
    expected,
    collection,
  );
  const result = inspectHTTPTrace(trace, {
    rootService: "edge-gateway",
    route: "/api/admin/{path...}",
    status: 201,
    captureRpcContent: collection.captureRpcContent,
    hops: [
      ...(resolution.source === "rpc"
        ? [["edge-gateway", "identity-service", 1]]
        : []),
      ["edge-gateway", "admin-console", 1],
      ["admin-console", "agent-controller", 1],
    ],
  });
  assert.deepEqual(result.services, [
    "admin-console",
    "agent-controller",
    "edge-gateway",
    ...(resolution.source === "rpc" ? ["identity-service"] : []),
  ]);
  const { database } = owningServer(trace, {
    service: "agent-controller",
    clientService: "admin-console",
    method: "POST",
    route: "/internal/agent-templates",
    status: 201,
  });
  assert(database.length > 0, "missing database execution evidence");
  const transactions = trace.spans.filter(
    (span) =>
      span.operationName === "postgresql transaction" &&
      trace.processes[span.processID].serviceName === "agent-controller",
  );
  assert.equal(
    transactions.length,
    1,
    "one catalog write transaction required",
  );
  assert.equal(
    tag(transactions[0], "antnest.transaction.outcome"),
    "committed",
  );
  return {
    result: { ...result, gateway_resolution: resolution },
    transactions,
  };
}
