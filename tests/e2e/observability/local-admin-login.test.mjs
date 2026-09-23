import assert from "node:assert/strict";
import test from "node:test";
import { inspectLocalAdminLogin } from "./local-admin-login.mjs";
import { fields } from "./trace-fixtures.mjs";
import { inspect } from "node:util";

function fixture(stage = "login") {
  const traceID = "a".repeat(32);
  const route = stage === "login" ? "/api/session/login" : "/api/session";
  const rpc = `/rpc/identity/${stage === "login" ? "local-login" : "resolve-access-token"}`;
  const span = (id, service, kind, parent, name, tags = {}) => ({
    traceID,
    spanID: id,
    processID: service,
    operationName: name,
    duration: 1,
    references: parent
      ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
      : [],
    tags: fields({ "span.kind": kind, ...tags }),
    logs: [],
  });
  const spans = [
    span("root", "edge", "server", null, "HTTP", {
      "http.route": route,
      "http.request.method": stage === "login" ? "POST" : "GET",
      "http.response.status_code": 200,
    }),
    span("client", "edge", "client", "root", "HTTP POST", {
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "server.address": "identity-service",
    }),
    span("identity", "identity", "server", "client", "HTTP POST", {
      "http.route": rpc,
      "rpc.method": stage === "login" ? "local_login" : "resolve_access_token",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    }),
  ];
  spans[2].logs = ["antnest.request", "antnest.response"].map((event) => ({
    fields: fields({ event, "antnest.payload.json": "{}" }),
  }));
  if (stage === "login")
    spans.push(
      span("tx", "identity", "internal", "identity", "postgresql transaction", {
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": "committed",
      }),
    );
  const operations =
    stage === "login"
      ? [
          "SELECT",
          "BEGIN",
          "SELECT",
          "SELECT",
          "SELECT",
          "INSERT",
          "INSERT",
          "COMMIT",
        ]
      : ["SELECT", "UPDATE"];
  operations.forEach((operation, index) =>
    spans.push(
      span(
        `sql-${index}`,
        "identity",
        "client",
        stage === "login" && index > 0 ? "tx" : "identity",
        operation,
        {
          "db.system.name": "postgresql",
          "db.operation.name": operation,
          "db.query.text": `${operation} /* fixture ${index} */`,
        },
      ),
    ),
  );
  return {
    traceID,
    processes: {
      edge: { serviceName: "edge-gateway" },
      identity: { serviceName: "identity-service" },
    },
    spans,
  };
}

for (const stage of ["login", "session"]) {
  test(`local admin ${stage} has exact HTTP and transaction ownership`, () => {
    const trace = fixture(stage);
    trace.spans.reverse();
    const result = inspectLocalAdminLogin(trace, stage);
    assert.equal(result.spans, stage === "login" ? 12 : 5);
    assert.equal(result.database_spans, stage === "login" ? 8 : 2);
    assert.equal(result.transactions, stage === "login" ? 1 : 0);
    assert.equal(result.errors, 0);
    assert.equal(result.diagnostic_events, 2);
  });
  for (const [name, mutate] of [
    [
      "hidden downstream",
      (t) => t.spans.push({ ...t.spans[1], spanID: "extra" }),
    ],
    [
      "HTTP 200 with error",
      (t) => t.spans[2].tags.push(...fields({ "error.type": "write_failed" })),
    ],
    [
      "error event",
      (t) =>
        t.spans[0].logs.push({ fields: fields({ event: "antnest.error" }) }),
    ],
    ["wrong HTTP parent", (t) => (t.spans[2].references[0].spanID = "root")],
    ["orphan SQL", (t) => (t.spans.at(-1).references = [])],
    [
      "wrong HTTP method",
      (t) =>
        (t.spans[0].tags.find((v) => v.key === "http.request.method").value =
          "PUT"),
    ],
    [
      "foreign service",
      (t) => (t.processes.identity.serviceName = "agent-controller"),
    ],
    [
      "wrong downstream status",
      (t) =>
        (t.spans[1].tags.find(
          (v) => v.key === "http.response.status_code",
        ).value = 503),
    ],
    [
      "duplicate SQL wrapper",
      (t) => t.spans.push({ ...t.spans.at(-1), spanID: "duplicate-sql" }),
    ],
    [
      "missing required SQL",
      (t) => {
        t.spans = t.spans.filter((s) => s.spanID !== "sql-0");
      },
    ],
    ["missing RPC response event", (t) => t.spans[2].logs.pop()],
    [
      "header content in log",
      (t) =>
        t.spans[0].logs.push({
          fields: fields({ "http.request.header.authorization": "private" }),
        }),
    ],
    [
      "ordinary HTTP payload",
      (t) =>
        t.spans[0].logs.push({
          fields: fields({ "antnest.payload.json": "{}" }),
        }),
    ],
    ["warning", (t) => (t.warnings = ["missing parent"])],
  ])
    test(`local admin ${stage} rejects ${name}`, () => {
      const trace = fixture(stage);
      mutate(trace);
      assert.throws(() => inspectLocalAdminLogin(trace, stage));
    });
}

test("session read within the last-used sample window needs no UPDATE", () => {
  const trace = fixture("session");
  trace.spans = trace.spans.filter((s) => s.operationName !== "UPDATE");
  const result = inspectLocalAdminLogin(trace, "session");
  assert.equal(result.spans, 4);
  assert.equal(result.database_spans, 1);
  assert.equal(result.errors, 0);
});

for (const operation of ["SELECT", "UPDATE", "INSERT", "DELETE"]) {
  test(`session read rejects an extra ${operation} execution`, () => {
    const trace = fixture("session");
    const extra = structuredClone(trace.spans.at(-1));
    extra.spanID = "extra-sql";
    extra.operationName = operation;
    extra.tags.find((v) => v.key === "db.operation.name").value = operation;
    extra.tags.find((v) => v.key === "db.query.text").value = operation;
    trace.spans.push(extra);
    assert.throws(() => inspectLocalAdminLogin(trace, "session"));
  });
}

for (const [name, mutate] of [
  [
    "rollback",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "tx")
        .tags.find((v) => v.key === "antnest.transaction.outcome").value =
        "rolled_back"),
  ],
  [
    "transaction detached",
    (t) =>
      (t.spans.find((s) => s.spanID === "tx").references[0].spanID = "client"),
  ],
  [
    "write outside transaction",
    (t) => (t.spans.at(-2).references[0].spanID = "identity"),
  ],
  [
    "unexpected statement",
    (t) => {
      const s = t.spans.at(-2);
      s.operationName = "UPDATE";
      s.tags.find((v) => v.key === "db.operation.name").value = "UPDATE";
    },
  ],
])
  test(`local admin login rejects ${name}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectLocalAdminLogin(trace, "login"));
  });

test("local admin verifier rejects unrelated scenarios", () => {
  assert.throws(() => inspectLocalAdminLogin(fixture(), "logout"));
});

for (const malformed of [false, true]) {
  test(`local admin errors never retain RPC secrets, malformed=${malformed}`, () => {
    const canary = "SYNTHETIC-LOGIN-SECRET-DO-NOT-PRINT";
    const trace = fixture();
    trace.spans[2].logs[0].fields.find(
      (f) => f.key === "antnest.payload.json",
    ).value = malformed
      ? `{"password":"${canary}"`
      : JSON.stringify({ password: canary });
    if (!malformed)
      trace.spans.find((s) => s.spanID === "tx").references[0].spanID =
        "client";
    assert.throws(
      () => inspectLocalAdminLogin(trace, "login"),
      (error) => {
        assert(!inspect(error, { depth: null }).includes(canary));
        return true;
      },
    );
  });
}
