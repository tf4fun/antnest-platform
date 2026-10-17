import assert from "node:assert/strict";
import test from "node:test";
import { inspectPrivateCostControlTrace } from "../acp-cost/control-trace.mjs";
import { costControlTraceFixture } from "../acp-cost/control-trace.fixture.mjs";
import { inspectPrivateCostConfigurationTrace } from "../acp-cost/configuration-trace.mjs";
import { costConfigurationTraceFixture } from "../acp-cost/configuration-trace.fixture.mjs";
import { inspectPrivateNativeTrace } from "../acp-multimodal/private-trace.mjs";
import { nativeTraceFixture } from "../acp-multimodal/private-trace.fixture.mjs";

const control = (f) =>
  inspectPrivateCostControlTrace(f.trace, f.expected, [], f.requests);
for (const version of [1, 2])
  for (const method of ["session/close", "session/delete"]) {
    const fixture = () => costControlTraceFixture({ version, method });
    test(`access keeps original ${method} refusal on private v${version}`, () => {
      const f = fixture(),
        original = structuredClone([f.trace, f.expected]);
      const report = control(f);
      assert.equal(report.no_execution, true);
      assert.equal(report.database_queries, 1);
      assert.equal(report.session_transactions, 0);
      assert.equal(report.owned_error_spans.length, 2);
      assert.deepEqual([f.trace, f.expected], original);
    });
    for (const [name, mutate] of [
      ["foreign Session", (f) => (f.expected.inputSessionID = "foreign")],
      [
        "wrong RPC error",
        (f) => (f.expected.rejectionReceipt.rpcCode = -32603),
      ],
      [
        "retryable rejection",
        (f) => (f.expected.rejectionReceipt.retryable = true),
      ],
      [
        "missing authorization read",
        (f) => {
          f.trace.spans = f.trace.spans.filter((s) => s !== f.authorization);
        },
      ],
      [
        "actual mutation",
        (f) =>
          f.add("write", f.application.spanID, "DELETE", undefined, 5000, {
            "span.kind": "client",
            "db.system.name": "postgresql",
            "db.operation.name": "DELETE",
            "db.query.text": "DELETE FROM acp_sessions",
          }),
      ],
      [
        "extra model call",
        (f) => f.requests.push({ trace_id: f.trace.traceID }),
      ],
      [
        "unrelated error",
        (f) => f.set(f.authorization, "otel.status_code", "ERROR"),
      ],
    ])
      test(`access ${method} v${version} refuses ${name}`, () => {
        const f = fixture();
        control(f);
        mutate(f);
        assert.throws(() => control(f));
      });
  }

const list = (f) =>
  inspectPrivateCostConfigurationTrace(f.trace, f.expected, [], f.requests);
test("access v2 list retains original SDK result and scoped read without execution", () => {
  const f = costConfigurationTraceFixture({
    version: 2,
    method: "session/list",
  });
  const before = structuredClone([f.trace, f.expected]);
  assert.equal(list(f).no_execution, true);
  assert.deepEqual([f.trace, f.expected], before);
});
for (const [name, mutate] of [
  ["missing receipt", (f) => delete f.expected.listReceipt],
  ["wrong request", (f) => (f.expected.listReceipt.requestId = "foreign")],
  ["wrong result Session", (f) => (f.expected.listSessionIds = ["foreign"])],
  [
    "Agent filter removed",
    (f) => {
      const query = f.queries[0];
      const text = query.tags.find((row) => row.key === "db.query.text");
      assert.match(text.value, /agent_id = \$2/u);
      text.value = text.value.replace("agent_id = $2", "TRUE");
    },
  ],
  [
    "unexpected Provider",
    (f) => f.requests.push({ trace_id: f.trace.traceID }),
  ],
])
  test(`access v2 list rejects ${name}`, () => {
    const f = costConfigurationTraceFixture({
      version: 2,
      method: "session/list",
    });
    list(f);
    mutate(f);
    assert.throws(() => list(f));
  });

const native = (f) =>
  inspectPrivateNativeTrace(f.trace, f.expected, [], f.requests);
for (const version of [1, 2])
  for (const modelName of ["scope-a", "scope-b"]) {
    test(`access v${version} no-tool Run binds its original ${modelName} model`, () => {
      const f = nativeTraceFixture({ version });
      f.expected.modelName = modelName;
      f.set(f.model, "model.name", modelName);
      const original = structuredClone([f.trace, f.expected]);
      assert.equal(native(f).no_tool_execution, true);
      assert.deepEqual([f.trace, f.expected], original);
      f.set(
        f.model,
        "model.name",
        modelName === "scope-a" ? "scope-b" : "scope-a",
      );
      assert.throws(() => native(f));
    });
  }
for (const modelName of ["", null, 1])
  test(`access rejects invalid expected model ${JSON.stringify(modelName)}`, () => {
    const f = nativeTraceFixture();
    f.expected.modelName = modelName;
    f.set(f.model, "model.name", modelName);
    assert.throws(() => native(f));
  });
