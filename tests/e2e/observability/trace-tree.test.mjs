import assert from "node:assert/strict";
import test from "node:test";
import { assertCaptureDisabled, owningServer, tag } from "./trace-tree.mjs";
import { databaseRequest, fields } from "./trace-fixtures.mjs";

const expected = {
  service: "agent-controller",
  method: "GET",
  route: "/internal/provider-connections/{connection_id}",
  rpcMethod: "GET /internal/provider-connections/{connection_id}",
  clientService: "admin-console",
  status: 200,
};
function fixture() {
  return {
    traceID: "trace",
    processes: {
      console: { serviceName: "admin-console" },
      controller: { serviceName: "agent-controller" },
    },
    spans: [
      {
        traceID: "trace",
        spanID: "client",
        processID: "console",
        operationName: "HTTP GET agent-controller",
        references: [],
        tags: fields({ "span.kind": "client", "http.request.method": "GET" }),
      },
      ...databaseRequest(
        "trace",
        "server",
        "client",
        "controller",
        expected.route,
        "GET",
      ),
    ],
  };
}
test("Provider read evidence uses SERVER identity and DB ownership, not SQL/table semantics or counts", () => {
  const trace = fixture();
  const first = owningServer(trace, expected);
  assert.equal(first.database.length, 1);
  trace.spans.push({ ...structuredClone(trace.spans[2]), spanID: "extra" });
  trace.spans[3].operationName = "UPDATE";
  trace.spans[3].tags.find((field) => field.key === "db.operation.name").value =
    "UPDATE";
  trace.spans[3].tags.find((field) => field.key === "db.query.text").value =
    "UPDATE arbitrary_fixture SET value=$1";
  assert.equal(owningServer(trace, expected).database.length, 2);
  assert.equal(tag(first.server, "http.route"), expected.route);
});
for (const operation of [
  "query",
  "query_one",
  "query_opt",
  "execute",
  "batch_execute",
])
  test(`reject legacy Rust postgresql ${operation} API name`, () => {
    const trace = fixture();
    trace.processes.controller.serviceName = "antnest-runtime-egress";
    trace.spans[2].operationName = `postgresql ${operation}`;
    trace.spans[2].tags.find(
      (field) => field.key === "db.operation.name",
    ).value = operation;
    assert.throws(
      () =>
        owningServer(trace, { ...expected, service: "antnest-runtime-egress" }),
      /low-cardinality driver operations/u,
    );
  });

function batchFixture() {
  const trace = fixture();
  trace.spans.push({
    traceID: "trace",
    spanID: "batch",
    processID: "controller",
    operationName: "batch start",
    duration: 5,
    references: [{ refType: "CHILD_OF", traceID: "trace", spanID: "server" }],
    tags: fields({ "span.kind": "client", "db.system.name": "postgresql" }),
  });
  trace.spans[2].references[0].spanID = "batch";
  return trace;
}
function transactionFixture(batch = false) {
  const trace = batch ? batchFixture() : fixture();
  const child = batch ? trace.spans[3] : trace.spans[2];
  child.references[0].spanID = "transaction";
  trace.spans.push({
    traceID: "trace",
    spanID: "transaction",
    processID: "controller",
    operationName: "postgresql transaction",
    duration: 8,
    references: [{ refType: "CHILD_OF", traceID: "trace", spanID: "server" }],
    tags: fields({ "span.kind": "internal", "db.system.name": "postgresql" }),
  });
  return trace;
}
for (const batch of [false, true])
  test(`transaction envelope preserves SQL ownership, batch=${batch}`, () => {
    const trace = transactionFixture(batch);
    for (const operation of ["BEGIN", "COMMIT", "ROLLBACK"]) {
      const query = structuredClone(trace.spans[2]);
      query.spanID = operation;
      query.operationName = operation;
      query.references[0].spanID = "transaction";
      query.tags.find((field) => field.key === "db.operation.name").value =
        operation;
      query.tags.find((field) => field.key === "db.query.text").value =
        operation.toLowerCase();
      trace.spans.push(query);
    }
    assert.equal(owningServer(trace, expected).database.length, 4);
  });
for (const [name, mutate] of [
  [
    "business wrapper",
    (span) => {
      span.operationName = "save_provider";
    },
  ],
  [
    "CLIENT masquerading as transaction",
    (span) => {
      span.tags[0].value = "client";
    },
  ],
  [
    "foreign service",
    (span) => {
      span.processID = "console";
    },
  ],
  [
    "detached transaction",
    (span) => {
      span.references = [];
    },
  ],
  [
    "missing database type",
    (span) => {
      span.tags.pop();
    },
  ],
])
  test(`transaction rejects ${name}`, () => {
    const trace = transactionFixture();
    mutate(trace.spans.at(-1));
    assert.throws(() => owningServer(trace, expected));
  });
test("SQL -> batch DB CLIENT -> owning SERVER counts executions, not containers", () => {
  const trace = batchFixture();
  assert.equal(owningServer(trace, expected).database.length, 1);
  trace.spans.push({
    ...structuredClone(trace.spans[2]),
    spanID: "second-query",
  });
  assert.equal(owningServer(trace, expected).database.length, 2);
});
test("multiple pure driver intermediates are allowed", () => {
  const trace = batchFixture();
  const outer = structuredClone(trace.spans[3]);
  outer.spanID = "outer-batch";
  trace.spans.push(outer);
  trace.spans[3].references[0].spanID = "outer-batch";
  assert.equal(owningServer(trace, expected).database.length, 1);
});
for (const [name, mutate] of [
  [
    "non-DB wrapper",
    (span) => {
      span.tags = fields({ "span.kind": "client" });
    },
  ],
  [
    "business wrapper with DB tags",
    (span) => {
      span.operationName = "get_provider_connection";
    },
  ],
  [
    "foreign service intermediary",
    (span) => {
      span.processID = "console";
    },
  ],
  [
    "non-CLIENT intermediary",
    (span) => {
      span.tags[0].value = "internal";
    },
  ],
  [
    "broken intermediary parent",
    (span) => {
      span.references = [];
    },
  ],
  [
    "foreign intermediary parent",
    (span) => {
      span.references[0].traceID = "foreign";
    },
  ],
])
  test(`batch DB chain rejects ${name}`, () => {
    const trace = batchFixture();
    mutate(trace.spans[3]);
    assert.throws(() => owningServer(trace, expected));
  });

for (const operation of ["connect", "acquire", "pool.acquire", "prepare"])
  test(`${operation} is not SQL execution evidence`, () => {
    const trace = fixture();
    const auxiliary = structuredClone(trace.spans[2]);
    auxiliary.spanID = "auxiliary";
    auxiliary.operationName = operation;
    auxiliary.tags = fields({
      "span.kind": "client",
      "db.system.name": "postgresql",
    });
    if (operation === "prepare")
      auxiliary.tags.push(
        ...fields({
          "db.query.text": "SELECT $1",
          "pgx.prepare_stmt.name": "cached",
        }),
      );
    trace.spans.push(auxiliary);
    if (operation !== "connect") {
      assert.throws(() => owningServer(trace, expected), /execution noise/u);
      return;
    }
    assert.equal(owningServer(trace, expected).database.length, 1);
    trace.spans.splice(2, 1);
    assert.throws(() => owningServer(trace, expected), /zero PostgreSQL/u);
  });

for (const [name, mutate] of [
  ["zero DB", (t) => t.spans.pop()],
  [
    "legacy db.system only",
    (t) => {
      t.spans[2].tags.find((f) => f.key === "db.system.name").key = "db.system";
    },
  ],
  [
    "empty query text",
    (t) => {
      t.spans[2].tags.find((f) => f.key === "db.query.text").value = "";
    },
  ],
  [
    "DB SERVER masquerading as CLIENT",
    (t) => {
      t.spans[2].tags[0].value = "server";
    },
  ],
  [
    "wrong service",
    (t) => {
      t.spans[2].processID = "console";
    },
  ],
  [
    "detached DB",
    (t) => {
      t.spans[2].references = [];
    },
  ],
  [
    "missing DB parent",
    (t) => {
      t.spans[2].references[0].spanID = "missing";
    },
  ],
  [
    "foreign DB parent",
    (t) => {
      t.spans[2].references[0].traceID = "foreign";
    },
  ],
  [
    "detached SERVER",
    (t) => {
      t.spans[1].references = [];
    },
  ],
  [
    "wrong CLIENT kind",
    (t) => {
      t.spans[0].tags[0].value = "server";
    },
  ],
  [
    "wrong route",
    (t) => {
      t.spans[1].tags.find((f) => f.key === "http.route").value = "/other";
    },
  ],
  [
    "wrong RPC",
    (t) => {
      t.spans[1].tags.find((f) => f.key === "rpc.method").value = "other";
    },
  ],
  [
    "duplicate business request",
    (t) => {
      t.spans.push({ ...t.spans[1], spanID: "duplicate" });
    },
  ],
  [
    "duplicate span",
    (t) => {
      t.spans.push(t.spans[2]);
    },
  ],
  [
    "trace warning",
    (t) => {
      t.warnings = ["clock skew"];
    },
  ],
  [
    "span warning",
    (t) => {
      t.spans[2].warnings = ["missing parent"];
    },
  ],
  [
    "SQL parameters",
    (t) => {
      t.spans[2].tags.push(...fields({ "db.query.parameter.1": "secret" }));
    },
  ],
  [
    "pgx parameters",
    (t) => {
      t.spans[2].tags.push(...fields({ "pgx.query.parameters": ["secret"] }));
    },
  ],
  [
    "missing standard operation",
    (t) => {
      t.spans[2].tags = t.spans[2].tags.filter(
        (f) => f.key !== "db.operation.name",
      );
    },
  ],
  [
    "business method as SQL name",
    (t) => {
      t.spans[2].operationName = "get_provider_connection";
    },
  ],
  [
    "unknown Rust business operation",
    (t) => {
      t.spans[2].operationName = "postgresql get_provider_connection";
      t.spans[2].tags.find((f) => f.key === "db.operation.name").value =
        "get_provider_connection";
    },
  ],
  [
    "mismatched Rust operation",
    (t) => {
      t.spans[2].operationName = "postgresql query";
      t.spans[2].tags.find((f) => f.key === "db.operation.name").value =
        "execute";
    },
  ],
  [
    "prepare without execution",
    (t) => {
      t.spans[2].tags.push(...fields({ "pgx.prepare_stmt.name": "cached" }));
    },
  ],
  [
    "SQL results",
    (t) => {
      t.spans[2].tags.push(...fields({ "db.query.result": "row" }));
    },
  ],
  [
    "legacy wrapper",
    (t) => {
      t.spans.push({
        traceID: "trace",
        spanID: "wrapper",
        processID: "controller",
        operationName: "agent_controller.repository.get_provider_connection",
        references: [
          { refType: "CHILD_OF", traceID: "trace", spanID: "server" },
        ],
      });
      t.spans[2].references[0].spanID = "wrapper";
    },
  ],
  [
    "detached second DB cannot hide behind a valid query",
    (t) => {
      t.spans.push({
        ...structuredClone(t.spans[2]),
        spanID: "detached",
        references: [],
      });
    },
  ],
])
  test(`DB ownership rejects ${name}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => owningServer(trace, expected));
  });

test("secret-free closeout fixtures explicitly reject capture=true content", () => {
  const trace = fixture();
  assertCaptureDisabled(trace);
  trace.spans[1].logs = [
    {
      fields: fields({
        event: "antnest.response",
        "antnest.payload.json": '{"token":"development-secret"}',
      }),
    },
  ];
  assert.throws(() => assertCaptureDisabled(trace), /capture=false/u);
});
