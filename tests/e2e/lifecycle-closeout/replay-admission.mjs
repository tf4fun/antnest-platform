import assert from "node:assert/strict";
import { clockSkewWarning } from "../../support/strict-findings.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { assertRPCParent } from "../observability/lifecycle-workflow.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";

export function inspectReadonlyCreateReplay(
  trace,
  { traceID, agentID },
  secrets = [],
) {
  assert.match(traceID, /^[a-f0-9]{32}$/u);
  assert.equal(trace?.traceID, traceID);
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const one = (items, description) => {
    assert.equal(items.length, 1, description);
    return items[0];
  };
  const root = one(
    trace.spans.filter((s) => !tree.parent(s)),
    "one replay request root required",
  );
  assert.equal(tree.service(root), "edge-gateway");
  const boundary = (span, route) => {
    assert.equal(tag(span, "span.kind"), "server");
    assert.equal(tag(span, "http.request.method"), "POST");
    assert.equal(tag(span, "http.route"), route);
    assert.equal(Number(tag(span, "http.response.status_code")), 202);
  };
  boundary(root, "/api/admin/{path...}");
  const admitted = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-controller" &&
        tag(s, "span.kind") === "server",
    ),
    "one replay admission required",
  );
  boundary(admitted, "/internal/agents");
  assert.equal(tag(admitted, "antnest.agent.id"), agentID);
  assertRPCParent(tree, admitted, "admin-console");
  const consoleServer = one(
    tree
      .chain(admitted)
      .filter(
        (s) =>
          tree.service(s) === "admin-console" &&
          tag(s, "span.kind") === "server",
      ),
    "replay Console parent missing",
  );
  boundary(consoleServer, "/api/admin/agents");
  assertRPCParent(tree, consoleServer, "edge-gateway");
  assert(tree.chain(admitted).includes(root));
  const descendants = trace.spans.filter(
    (s) => s !== admitted && tree.chain(s).includes(admitted),
  );
  const transaction = one(
    descendants.filter((s) => s.operationName === "postgresql transaction"),
    "replay must use one read-only transaction",
  );
  assert.equal(tree.parent(transaction), admitted);
  const queries = [];
  for (const span of descendants) {
    assert.equal(
      tree.service(span),
      "agent-controller",
      "replay invoked another service",
    );
    if (span === transaction) continue;
    assert.equal(
      tree.parent(span),
      transaction,
      "replay effect is outside its read-only transaction",
    );
    // pgx may open a pooled connection while BeginTx retains this context.
    // It is transport evidence, never a substitute for the actual SQL below.
    if (span.operationName === "connect") {
      assert.equal(tag(span, "span.kind"), "client");
      assert.equal(tag(span, "db.system.name"), "postgresql");
      for (const field of [
        "db.query.text",
        "db.operation.name",
        "http.request.method",
        "rpc.method",
        "rpc.system",
      ])
        assert.equal(
          tag(span, field),
          undefined,
          "connection span contains a replay effect",
        );
      continue;
    }
    assert(
      ["BEGIN", "SELECT", "COMMIT"].includes(span.operationName),
      "replay performed a write or dispatched work",
    );
    assert.equal(tag(span, "db.operation.name"), span.operationName);
    const sql = tag(span, "db.query.text");
    assert.equal(typeof sql, "string");
    assert(
      new RegExp(`^\\s*${span.operationName}\\b`, "iu").test(sql),
      "replay SQL differs from its operation",
    );
    queries.push(span);
  }
  const begin = one(
    queries.filter((s) => s.operationName === "BEGIN"),
    "read-only BEGIN missing",
  );
  assert(
    /\bread\s+only\s*;?\s*$/iu.test(tag(begin, "db.query.text")),
    "replay transaction is not read only",
  );
  one(
    queries.filter((s) => s.operationName === "COMMIT"),
    "replay COMMIT missing",
  );
  assert(
    queries.some(
      (s) =>
        s.operationName === "SELECT" &&
        /\bagent_controller\.agent_lifecycle_operations\b/u.test(
          tag(s, "db.query.text"),
        ),
    ),
    "replayed operation was not read",
  );
  for (const span of trace.spans) {
    assert(
      Number.isFinite(span.duration) && span.duration >= 0,
      "unfinished replay span",
    );
    assert(!hasError(span), "replay trace contains errors");
  }
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((s) => s.warnings ?? []),
  ];
  assert(
    warnings.every((w) => typeof w === "string" && clockSkewWarning.test(w)),
    "unreviewed replay trace warning",
  );
  return {
    kind: "create-replay",
    topology: "passed",
    trace_id: traceID,
    agent_id: agentID,
    spans: trace.spans.length,
    strict_trace: warnings.length ? "failed" : "passed",
    warning_count: warnings.length,
    warnings,
    error_spans: 0,
    readonly_transaction: true,
  };
}
