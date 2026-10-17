import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { privatePersistenceFaultFixture as fixture } from "./fault-trace.fixture.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";
import { addPostPromptInformationRead } from "../observability/runtime-information-run-fixtures.mjs";
const url = new URL("./fault-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f) => {
  assert.equal(
    typeof implementation.inspectPrivatePersistenceFaultTrace,
    "function",
  );
  return implementation.inspectPrivatePersistenceFaultTrace(
    f.trace,
    f.expected,
    f.fault,
    ["PRIVATE-PERSISTENCE-CANARY"],
    f.requests,
  );
};
const reasons = new Set([
  "persistence-lost-acknowledgement",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);
test("finish cannot claim a different CTE with the same SQL prefix and matching proxy hash", () => {
  const f = fixture(1, "finish");
  const original = f.sql.tags.find((row) => row.key === "db.query.text").value;
  const changed = original.replace(
    ") SELECT id FROM finished",
    "), unowned AS (DELETE FROM runs RETURNING *) SELECT id FROM finished",
  );
  assert.notEqual(changed, original);
  f.set(f.sql, "db.query.text", changed);
  f.fault.held.query_hash = f.fault.record.query_hash = createHash("sha256")
    .update(changed)
    .digest("hex");
  assert.throws(() => inspect(f));
});
test("acceptance cannot precede its durable intent transaction", () => {
  const f = fixture(1, "accept");
  const first = f.admissionTransactions[0];
  for (const span of [first.tx, ...first.items]) span.startTime += 60;
  assert.throws(() => inspect(f));
});
for (const version of [1, 2])
  for (const phase of ["intent", "accept", "finish"])
    test(`private v${version} ${phase} claims only its lost acknowledgement and exact propagation`, () => {
      const f = fixture(version, phase),
        before = structuredClone({
          trace: f.trace,
          expected: f.expected,
          fault: f.fault,
          requests: f.requests,
        });
      const result = inspect(f);
      const inventory = privateACPDiagnosticInventory(
        [f.trace, f.expected.connectionTrace],
        [result],
        reasons,
      );
      assert.equal(inventory.diagnostic_inventory_verified, true);
      assert.equal(result.selected_sql_verified, true);
      assert.equal(result.runtime_tool_calls, phase === "finish" ? 1 : 0);
      assert.equal(result.provider_requests, phase === "finish" ? 2 : 0);
      assert(
        result.owned_error_spans.every(
          (row) =>
            row.receipt_id === "receipt" &&
            row.failed_sql_span_id === f.failed.spanID,
        ),
      );
      assert.deepEqual(f.trace, before.trace);
      assert.deepEqual(f.expected, before.expected);
      assert.deepEqual(f.fault, before.fault);
      assert.deepEqual(f.requests, before.requests);
    });
test("v1 finish retains the original fault while validating its successful final Runtime refresh", () => {
  const f = fixture(1, "finish");
  addPostPromptInformationRead(f.trace);
  const before = structuredClone(f.trace);
  const result = inspect(f);
  assert.equal(result.post_prompt_information_reads, 1);
  assert.deepEqual(f.trace, before);
});
test("successful compensating ROLLBACK is not claimed as an error", () => {
  const f = fixture();
  for (const key of ["error", "error.type", "otel.status_code"])
    f.set(f.rollback, key, undefined);
  f.origin.logs[0].fields.find(
    (row) => row.key === "antnest.error.cause_types",
  ).value = "[]";
  f.origin.logs[0].fields.find(
    (row) => row.key === "antnest.error.causes",
  ).value = JSON.stringify([
    { type: "Error", message: "Error: unregistered message omitted" },
  ]);
  const result = inspect(f);
  assert(
    !result.owned_error_spans.some((row) => row.span_id === f.rollback.spanID),
  );
});
test("driver exception and numeric ERROR status retain exact original error evidence", () => {
  const f = fixture();
  f.set(f.failed, "otel.status_code", 2);
  f.set(f.failed, "error.type", "Error");
  f.set(
    f.failed,
    "otel.status_description",
    "Connection terminated unexpectedly",
  );
  f.failed.logs = [
    {
      timestamp: f.failed.startTime,
      fields: Object.entries({
        event: "exception",
        "exception.type": "Error",
        "exception.message": "Connection terminated unexpectedly",
        "exception.stacktrace": "Error: Connection terminated unexpectedly",
        "exception.escaped": false,
      }).map(([key, value]) => ({ key, value })),
    },
  ];
  assert.equal(inspect(f).selected_sql_verified, true);
});
for (const phase of ["accept", "finish"])
  test(`${phase} preserves optional environment-change admission SQL`, () => {
    assert.equal(
      inspect(fixture(1, phase, { environmentChange: true }))
        .selected_sql_verified,
      true,
    );
  });
for (const foreign of [false, true])
  test(`rejects hidden ${foreign ? "foreign-process" : "same-process"} SQL below a known admission SQL`, () => {
    const f = fixture();
    const resource = f.trace.processes[f.sql.processID];
    const hidden = f.add(
      "hidden",
      f.sql.spanID,
      "INSERT",
      "agent-acp-service",
      f.sql.startTime + 0.1,
      {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": "INSERT",
        "db.query.text": "INSERT INTO unowned VALUES ($1)",
      },
    );
    hidden.duration = 0.1;
    f.trace.processes[f.sql.processID] = resource;
    if (foreign) {
      hidden.processID = "foreign";
      f.trace.processes.foreign = structuredClone(resource);
      f.trace.processes.foreign.tags.find((row) => row.key === "process.pid")
        .value++;
    }
    assert.throws(() => inspect(f));
  });
for (const version of [1, 2])
  for (const phase of ["intent", "accept", "finish"]) {
    const base = fixture(version, phase);
    for (const transaction of base.admissionTransactions)
      for (const item of transaction.items)
        test(`v${version} ${phase} rejects missing admission SQL ${item.spanID}`, () => {
          const f = fixture(version, phase);
          f.trace.spans = f.trace.spans.filter(
            (span) => span.spanID !== item.spanID,
          );
          assert.throws(() => inspect(f));
        });
  }
for (const [name, mutate, phase = "intent", version = 1] of [
  [
    "foreign held Session",
    (f) => {
      f.fault.held.session_id = "foreign";
    },
  ],
  [
    "foreign held Run",
    (f) => {
      f.fault.held.run_id = "foreign";
    },
  ],
  [
    "wrong phase",
    (f) => {
      f.fault.held.phase = "finish";
    },
  ],
  [
    "wrong query hash",
    (f) => {
      f.fault.held.query_hash = "f".repeat(64);
    },
  ],
  [
    "changed drop receipt",
    (f) => {
      f.fault.record.receipt_id = "other";
    },
  ],
  [
    "changed drop Run",
    (f) => {
      f.fault.record.run_id = "other";
    },
  ],
  [
    "changed drop Session",
    (f) => {
      f.fault.record.session_id = "other";
    },
  ],
  [
    "changed drop query",
    (f) => {
      f.fault.record.query_hash = "f".repeat(64);
    },
  ],
  [
    "changed recovered Session",
    (f) => {
      f.fault.after.run.session_id = "other";
    },
  ],
  [
    "missing driver exception",
    (f) => {
      f.set(f.failed, "error.type", "Error");
    },
  ],
  [
    "COMMIT precedes selected write",
    (f) => {
      f.failed.startTime = f.sql.startTime - 1;
    },
  ],
  [
    "ROLLBACK precedes COMMIT",
    (f) => {
      f.rollback.startTime = f.failed.startTime - 1;
    },
  ],
  [
    "expired injected receipt",
    (f) => {
      f.fault.record.delivery = "expired";
    },
  ],
  [
    "SIGKILL substitution",
    (f) => {
      f.fault.natural_exit = 137;
    },
  ],
  [
    "rewritten history",
    (f) => {
      f.fault.after.events.items.push({ kind: "agent_message" });
    },
  ],
  [
    "missing COMMIT",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s !== f.failed);
    },
  ],
  [
    "missing attempted ROLLBACK",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s !== f.rollback);
    },
  ],
  [
    "foreign transaction",
    (f) => {
      f.failed.references[0].spanID = f.app.spanID;
    },
  ],
  [
    "extra ACP Error",
    (f) => {
      f.set(f.sql, "error", true);
      f.set(f.sql, "error.type", "Error");
    },
  ],
  [
    "wrong propagated origin",
    (f) => {
      f.set(f.request, "antnest.error.origin_span_id", f.sql.spanID);
    },
  ],
  [
    "unrelated origin event",
    (f) => {
      f.origin.logs[0].fields.find(
        (x) => x.key === "antnest.error.stage",
      ).value = "model.complete";
    },
  ],
  [
    "extra origin event",
    (f) => {
      f.origin.logs.push(structuredClone(f.origin.logs[0]));
    },
  ],
  [
    "application process mismatch",
    (f) => {
      f.trace.processes.foreign = structuredClone(
        f.trace.processes[f.app.processID],
      );
      f.trace.processes.foreign.tags.find((x) => x.key === "process.pid")
        .value++;
      f.app.processID = "foreign";
    },
  ],
  [
    "request fake success",
    (f) => {
      f.expected.outcome = "succeeded";
    },
  ],
  [
    "connection error",
    (f) => {
      f.expected.connectionTrace.spans[1].tags.push({
        key: "error",
        value: true,
      });
    },
  ],
  [
    "missing parent",
    (f) => {
      f.sql.references[0].spanID = "absent";
    },
  ],
  [
    "captured SQL parameters",
    (f) => {
      f.set(f.sql, "db.query.parameters", "private");
    },
  ],
  [
    "secret captured",
    (f) => {
      f.set(f.sql, "custom", "PRIVATE-PERSISTENCE-CANARY");
    },
  ],
  [
    "unfinished SQL",
    (f) => {
      f.sql.duration = -1;
    },
  ],
  [
    "Provider before acceptance",
    (f) => {
      f.requests.push({ phase: f.expected.label, trace_id: f.trace.traceID });
    },
  ],
  [
    "foreign finish Run",
    (f) => {
      f.set(f.origin, "antnest.run.id", "other");
    },
    "finish",
  ],
  [
    "finish bypasses admission",
    (f) => {
      f.origin.references[0].spanID = f.request.spanID;
    },
    "finish",
  ],
  [
    "finish SQL precedes Model completion request",
    (f) => {
      f.failed.startTime = f.origin.startTime;
    },
    "finish",
  ],
  [
    "missing finish Tool",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (s) => s.operationName !== "runtime.mcp.tool",
      );
    },
    "finish",
  ],
  [
    "missing Runtime information read",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (s) => s.operationName !== "mcp.runtime.info.read",
      );
    },
    "finish",
  ],
  [
    "wrong Provider phase",
    (f) => {
      f.requests[0].phase = "other";
    },
    "finish",
  ],
  [
    "foreign Provider Trace",
    (f) => {
      f.requests[0].trace_id = "f".repeat(32);
    },
    "finish",
  ],
  [
    "v2 finish RPC failure",
    (f) => {
      f.error(f.request, f.origin);
    },
    "finish",
    2,
  ],
  [
    "v2 ACK lost",
    (f) => {
      delete f.expected.requestResult.messageId;
    },
    "finish",
    2,
  ],
  [
    "v2 ACK belongs to another durable message",
    (f) => {
      f.expected.requestResult.messageId = "other";
    },
    "finish",
    2,
  ],
  ...["identity-service", "agent-controller"].map((service) => [
    `unexpected ${service} in finish Run`,
    (f) => {
      f.add("management", f.origin.spanID, "unexpected management", service);
    },
    "finish",
  ]),
])
  test(`private fault rejects ${name}`, () => {
    const f = fixture(version, phase);
    mutate(f);
    assert.throws(() => inspect(f));
  });
