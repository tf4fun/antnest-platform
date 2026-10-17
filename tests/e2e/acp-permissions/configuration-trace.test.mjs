import assert from "node:assert/strict";
import test from "node:test";
import { permissionConfigurationFixture as fixture } from "./configuration-trace.fixture.mjs";
import { tag } from "../observability/trace-tree.mjs";

const target = new URL("./configuration-trace.mjs", import.meta.url);
const { inspectPermissionConfigurationTrace: inspect } = await import(
  target.href
).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === target.href)
    return {};
  throw error;
});
const available = () =>
  assert.equal(
    typeof inspect,
    "function",
    "Permissions configuration inspector required",
  );
const check = (f) => inspect(f.trace, f.expected, ["PRIVATE"], f.requests);
const remove = (f, id) => {
  f.trace.spans = f.trace.spans.filter((span) => span.spanID !== id);
};
const parent = (f, span, owner) => {
  span.references = [
    { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: owner.spanID },
  ];
};
const foreign = (f, span) => {
  const resource = structuredClone(f.trace.processes[span.processID]);
  resource.tags.find((field) => field.key === "process.pid").value++;
  f.trace.processes.foreign = resource;
  span.processID = "foreign";
};
const sql = (f, id, before, after) => {
  const span = f.query(id),
    original = tag(span, "db.query.text");
  assert(original.includes(before));
  f.set(span, "db.query.text", original.replace(before, after));
};
const changes = [
  [
    "mode described as model",
    (f) => {
      f.expected.configuration.configId = "model";
    },
  ],
  [
    "foreign expected choice",
    (f) => {
      f.expected.configuration.value = "chat";
    },
  ],
  [
    "unknown configuration",
    (f) => {
      f.expected.configuration.configId = "secret-setting";
      f.expected.requestReceipt.params.configId = "secret-setting";
      f.expected.requestReceipt.result.configOptions[0][
        f.expected.protocolVersion === 1 ? "id" : "configId"
      ] = "secret-setting";
    },
  ],
  [
    "missing real receipt",
    (f) => {
      delete f.expected.requestReceipt;
    },
  ],
  [
    "foreign receipt ID",
    (f) => {
      f.expected.requestReceipt.requestId = "other-request";
    },
  ],
  [
    "foreign receipt Session",
    (f) => {
      f.expected.requestReceipt.params.sessionId = "other-session";
    },
  ],
  [
    "extra request parameter",
    (f) => {
      f.expected.requestReceipt.params.expectedRevision = "unobserved";
    },
  ],
  [
    "foreign current selection",
    (f) => {
      f.expected.requestReceipt.result.configOptions[0].currentValue = "chat";
    },
  ],
  [
    "duplicate returned selection",
    (f) => {
      f.expected.requestReceipt.result.configOptions.push(
        structuredClone(f.expected.requestReceipt.result.configOptions[0]),
      );
    },
  ],
  [
    "wrong returned option key",
    (f) => {
      const option = f.expected.requestReceipt.result.configOptions[0];
      option[f.expected.protocolVersion === 1 ? "configId" : "id"] = "mode";
      delete option[f.expected.protocolVersion === 1 ? "id" : "configId"];
    },
  ],
  [
    "missing successful outcome",
    (f) => {
      f.expected.outcome = "failed";
    },
  ],
  [
    "borrowed rejection",
    (f) => {
      f.expected.rejectionReceipt = {
        rpcCode: -32020,
        code: "access_denied",
        retryable: false,
      };
    },
  ],
  [
    "foreign input Session",
    (f) => {
      f.expected.inputSessionID = "foreign";
    },
  ],
  ["missing configuration application", (f) => remove(f, "application")],
  [
    "duplicate configuration application",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.application),
        spanID: "duplicate",
      }),
  ],
  ["foreign application process", (f) => foreign(f, f.application)],
  [
    "foreign application Agent",
    (f) => f.set(f.application, "antnest.agent.id", "foreign"),
  ],
  [
    "foreign application Session",
    (f) => f.set(f.application, "session.id", "foreign"),
  ],
  [
    "missing output read",
    (f) => {
      const ids = new Set(
        f.outputs.flatMap((row) => [
          row.application.spanID,
          ...row.queries.map((span) => span.spanID),
        ]),
      );
      f.trace.spans = f.trace.spans.filter((span) => !ids.has(span.spanID));
    },
  ],
  ["missing output SELECT", (f) => remove(f, f.outputs[0].queries[1].spanID)],
  [
    "pre-configuration reads actually following commit",
    (f) => {
      const output = f.outputs[0];
      const start = f.query("commit").startTime + 1000;
      output.queries.forEach((span, index) => {
        span.startTime = start + index * 100;
      });
      output.application.duration = start + 500 - output.application.startTime;
    },
  ],
  [
    "wrong output identity",
    (f) => f.set(f.outputs[0].application, "antnest.session.id", "foreign"),
  ],
  ["missing transaction", (f) => remove(f, "transaction")],
  [
    "uncommitted transaction",
    (f) => f.set(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "transaction outside configuration",
    (f) => parent(f, f.transaction, f.request),
  ],
  ["missing configuration update", (f) => remove(f, "update")],
  ["missing configuration message", (f) => remove(f, "insert")],
  ["missing commit", (f) => remove(f, "commit")],
  [
    "duplicate commit",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.query("commit")),
        spanID: "second-commit",
      }),
  ],
  [
    "weakened revision compare",
    (f) => sql(f, "update", "configuration_revision = $2", "TRUE"),
  ],
  [
    "removed deleted guard",
    (f) => sql(f, "update", "AND state <> 'deleted'", ""),
  ],
  [
    "invisible configuration message",
    (f) => sql(f, "insert", "'configuration', true", "'configuration', false"),
  ],
  [
    "configuration query detached",
    (f) => parent(f, f.query("update"), f.application),
  ],
  ["foreign database process", (f) => foreign(f, f.query("update"))],
  [
    "wrong database namespace",
    (f) => f.set(f.query("update"), "db.namespace", "other"),
  ],
  [
    "SQL operation name contradicting its statement",
    (f) => {
      f.query("update").operationName = "SELECT";
    },
  ],
  [
    "hidden SQL error",
    (f) => f.set(f.query("update"), "error.type", "DatabaseError"),
  ],
  [
    "reversed statement starts",
    (f) => {
      f.query("insert").startTime = f.query("update").startTime - 1;
    },
  ],
  ["unexpected Run", (f) => f.add("run", "request", "agent.run")],
  ["unexpected model", (f) => f.add("model", "request", "model.complete")],
  ["unexpected Tool", (f) => f.add("tool", "request", "runtime.mcp.tool")],
  [
    "unexpected approval wait",
    (f) => f.add("permission", "request", "acp.permission.wait"),
  ],
  [
    "unexpected Provider receipt",
    (f) => f.requests.push({ trace_id: "foreign", phase: "foreign" }),
  ],
  [
    "payload capture",
    (f) => f.set(f.application, "antnest.payload.json", "{}"),
  ],
  [
    "database parameter capture",
    (f) => f.set(f.query("update"), "db.query.parameters", "[]"),
  ],
  ["secret in source", (f) => f.set(f.application, "secret", "PRIVATE")],
];

for (const version of [1, 2]) {
  for (const [configId, value] of [
    ["mode", "approve"],
    ["mode", "chat"],
    ["mode", "smart_approve"],
    ["model", "profile:alternate"],
  ])
    test(`v${version}: private Permissions ${configId}=${value} binds the actual receipt and complete committed mutation`, () => {
      available();
      const f = fixture({ version, configId, value });
      const original = structuredClone({
        trace: f.trace,
        expected: f.expected,
      });
      const result = check(f);
      assert.equal(result.configuration_committed, true);
      assert.equal(result.configuration_id, configId);
      assert.equal(result.selection, value);
      assert.equal(result.input_session_id, f.expected.sessionId);
      assert.equal(result.database_queries, 12);
      assert.equal(result.output_reads, 1);
      assert.equal(result.no_execution, true);
      assert.equal(result.sql_parameters_observed, false);
      assert.deepEqual(f.trace, original.trace);
      assert.deepEqual(f.expected, original.expected);
    });
  test(`v${version}: repeated post-configuration output reads and unordered span enumeration remain valid`, () => {
    available();
    const f = fixture({ version, outputReads: 3 });
    f.trace.spans.reverse();
    const result = check(f);
    assert.equal(result.database_queries, 20);
    assert.equal(result.output_reads, 3);
  });
  test(`v${version}: configuration keeps legal grouped model choices and additional thinking options`, () => {
    available();
    const f = fixture({
      version,
      configId: "model",
      value: "profile:alternate",
    });
    const key = version === 1 ? "id" : "configId";
    const selected = f.expected.requestReceipt.result.configOptions[0];
    selected.options = [
      {
        [version === 1 ? "group" : "groupId"]: "provider",
        name: "Provider",
        options: [{ value: "profile:alternate", name: "Alternate model" }],
      },
    ];
    f.expected.requestReceipt.result.configOptions.push({
      [key]: "thinking_effort",
      name: "Thinking",
      type: "select",
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    });
    assert.equal(check(f).selection, "profile:alternate");
  });
  for (const [label, mutate] of changes)
    test(`v${version}: Permissions configuration rejects ${label}`, () => {
      available();
      const f = fixture({ version });
      check(f);
      mutate(f);
      assert.throws(() => check(f));
    });
}
test("v2: mode configuration requires its actual id-typed request", () => {
  available();
  const f = fixture({ version: 2 });
  delete f.expected.requestReceipt.params.type;
  assert.throws(() => check(f));
});
