import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectReadonlyCreateReplay } from "./replay-admission.mjs";

function fixture() {
  const traceID = "b".repeat(32);
  const expected = { traceID, agentID: "agent_test" };
  const trace = { traceID, spans: [], processes: {} };
  const add = (id, service, name, parent, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID,
      spanID: id,
      processID: service,
      operationName: name,
      startTime: 1,
      duration: 1,
      references: parent
        ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  };
  const http = (kind, route) => ({
    "span.kind": kind,
    "http.request.method": "POST",
    "http.response.status_code": 202,
    ...(route ? { "http.route": route } : {}),
  });
  add(
    "gateway",
    "edge-gateway",
    "POST /api/admin/{path...}",
    null,
    http("server", "/api/admin/{path...}"),
  );
  add("gateway-client", "edge-gateway", "HTTP POST", "gateway", http("client"));
  add(
    "console",
    "admin-console",
    "POST /api/admin/agents",
    "gateway-client",
    http("server", "/api/admin/agents"),
  );
  add(
    "console-client",
    "admin-console",
    "HTTP POST",
    "console",
    http("client"),
  );
  add("admit", "agent-controller", "POST /internal/agents", "console-client", {
    ...http("server", "/internal/agents"),
    "antnest.agent.id": expected.agentID,
  });
  add("transaction", "agent-controller", "postgresql transaction", "admit");
  for (const [id, operation, sql] of [
    ["begin", "BEGIN", "begin isolation level repeatable read read only"],
    [
      "select",
      "SELECT",
      "SELECT request_id FROM agent_controller.agent_lifecycle_operations WHERE request_id=$1",
    ],
    ["commit", "COMMIT", "commit"],
  ])
    add(id, "agent-controller", operation, "transaction", {
      "db.operation.name": operation,
      "db.query.text": sql,
    });
  return { trace, expected, add };
}

test("failed-start Create replay proves one read-only transaction under its real admission", () => {
  const f = fixture();
  const before = JSON.stringify(f.trace);
  const result = inspectReadonlyCreateReplay(f.trace, f.expected);
  assert.equal(result.trace_id, f.expected.traceID);
  assert.equal(result.strict_trace, "passed");
  assert.equal(result.topology, "passed");
  assert.equal(JSON.stringify(f.trace), before);
});

test("a successful pgx connection opened for the transaction is not a replay effect", () => {
  const f = fixture();
  f.add("connect", "agent-controller", "connect", "transaction", {
    "span.kind": "client",
    "db.system.name": "postgresql",
  });
  assert.equal(
    inspectReadonlyCreateReplay(f.trace, f.expected).readonly_transaction,
    true,
  );
  for (const patch of [
    {
      "db.query.text":
        "UPDATE agent_controller.agents SET runtime_state='waiting'",
    },
    { "db.operation.name": "UPDATE" },
    { "http.request.method": "POST" },
    { "rpc.method": "restart" },
    { error: true },
    { "span.kind": "server" },
    { "db.system.name": "other" },
  ]) {
    const altered = structuredClone(f.trace);
    const connect = altered.spans.find((s) => s.spanID === "connect");
    connect.tags = Object.entries({
      "span.kind": "client",
      "db.system.name": "postgresql",
      ...patch,
    }).map(([key, value]) => ({ key, value }));
    assert.throws(() => inspectReadonlyCreateReplay(altered, f.expected));
  }
});

for (const [name, mutate] of [
  [
    "wrong replay trace",
    (f) => {
      f.expected.traceID = "c".repeat(32);
    },
  ],
  [
    "wrong Agent",
    (f) => {
      f.expected.agentID = "other";
    },
  ],
  [
    "no read-only begin",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "begin")
        .tags.find((t) => t.key === "db.query.text").value = "begin";
    },
  ],
  [
    "no commit",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "commit");
    },
  ],
  [
    "mutating SQL",
    (f) => {
      f.add("update", "agent-controller", "UPDATE", "transaction", {
        "db.operation.name": "UPDATE",
        "db.query.text":
          "UPDATE agent_controller.agents SET runtime_state='waiting'",
      });
    },
  ],
  [
    "write disguised as SELECT",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "select")
        .tags.find((t) => t.key === "db.query.text").value =
        "WITH changed AS (DELETE FROM agent_controller.agents RETURNING *) SELECT * FROM changed";
    },
  ],
  [
    "SQL outside read-only transaction",
    (f) => {
      f.trace.spans.find((s) => s.spanID === "select").references[0].spanID =
        "admit";
    },
  ],
  [
    "same-ID Runtime restart",
    (f) => {
      f.add("restart-client", "agent-controller", "HTTP POST", "admit", {
        "span.kind": "client",
        "http.request.method": "POST",
      });
      f.add(
        "restart",
        "runtime-controller",
        "POST /internal/runtimes/{agent_id}/enable",
        "restart-client",
        { "span.kind": "server" },
      );
    },
  ],
  [
    "Egress write",
    (f) => {
      f.add("egress", "antnest-runtime-egress", "PUT", "admit", {
        "span.kind": "server",
      });
    },
  ],
  [
    "new workflow",
    (f) => {
      f.add(
        "workflow",
        "agent-controller",
        "StartWorkflow:CreateAgentWorkflow",
        "admit",
      );
    },
  ],
  [
    "second transaction",
    (f) => {
      f.add(
        "transaction2",
        "agent-controller",
        "postgresql transaction",
        "admit",
      );
    },
  ],
  [
    "detached admission",
    (f) => {
      f.trace.spans.find((s) => s.spanID === "admit").references = [];
    },
  ],
  [
    "unknown warning",
    (f) => {
      f.trace.warnings = ["missing spans"];
    },
  ],
  [
    "error span",
    (f) => {
      f.trace.spans[4].tags.push({ key: "error", value: true });
    },
  ],
])
  test(`read-only replay rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspectReadonlyCreateReplay(f.trace, f.expected));
  });

test("read-only replay retains reviewed clock warnings as strict failure", () => {
  const f = fixture();
  const warning =
    "clock skew adjustment disabled; not applying calculated delta of 500µs";
  f.trace.warnings = [warning];
  const result = inspectReadonlyCreateReplay(f.trace, f.expected);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(result.warnings, [warning]);
  assert.deepEqual(f.trace.warnings, [warning]);
});
