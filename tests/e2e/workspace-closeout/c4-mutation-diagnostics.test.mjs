import assert from "node:assert/strict";
import test from "node:test";
import { c4RevocationTraceFixture } from "./c4-revocation-trace.fixture.mjs";
import { inspectC4RevocationTrace } from "./c4-revocation-trace.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const lookup = `SELECT request_id, request_fingerprint, agent_id, kind, phase, state,
  source_spec_revision_id, source_execution_revision_id,
  source_runtime_revision, source_runtime_absent,
  target_spec_revision_id, child_request_id, network_attachment,
  source_runtime_inspection, source_runtime_absence_proof, runtime_result,
  network_release_outcome, error_code, error_detail, retryable,
  created_at, updated_at, owner_revocation_sequence, drain_deadline_at, settlement_outcome
  FROM agent_controller.agent_lifecycle_operations WHERE request_id = $1`;

function add(f, parent, id, operationName, fields) {
  const span = {
    traceID: f.raw.trace.traceID,
    spanID: id,
    processID: parent.processID,
    operationName,
    startTime: parent.startTime,
    duration: 0,
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.raw.trace.traceID,
        spanID: parent.spanID,
      },
    ],
    tags: Object.entries(fields).map(([key, value]) => ({ key, value })),
  };
  f.raw.trace.spans.push(span);
  return span;
}
function inspect(f) {
  return inspectC4RevocationTrace(f.trace, f.expected, [], f.collection);
}
function readOnlyReplay(ownerName) {
  const f = c4RevocationTraceFixture(),
    owner = f.raw.trace.spans.find((s) => s.operationName === ownerName);
  assert(owner);
  f.replay = add(f, owner, "empty-replay", "postgresql transaction", {
    "span.kind": "internal",
    "db.system.name": "postgresql",
    "antnest.transaction.outcome": "rolled_back",
  });
  for (const [operation, query] of [
    ["BEGIN", "begin isolation level repeatable read read only"],
    ["SELECT", lookup],
    ["ROLLBACK", "rollback"],
  ])
    f[operation] = add(f, f.replay, "empty-" + operation, operation, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": operation,
      "db.query.text": query,
      "pgx.rows_affected": 0,
    });
  return f;
}
function completedDelete() {
  const f = c4RevocationTraceFixture(),
    owner = f.raw.trace.spans.find(
      (s) => s.spanID === "rpc-lifecycle.runtime_disable",
    );
  f.platform = add(
    f,
    owner,
    "completed-platform-delete",
    "runtime.platform.delete",
    {
      "antnest.agent.id": f.expected.agentId,
      "antnest.platform": "docker",
      "antnest.platform.operation": "delete",
      "antnest.result": "completed",
      "antnest.outcome": "completed",
      "antnest.error.code": "",
    },
  );
  return f;
}

test("C4 retains the empty error code emitted by a completed Runtime deletion", () => {
  const f = completedDelete(),
    original = structuredClone(f.raw.trace);
  assert.equal(inspect(f).authorizationCauseVerified, true);
  assert.deepEqual(f.raw.trace, original);
});
for (const [field, value] of [
  ["antnest.error.code", "platform_operation_failed"],
  ["error", true],
  ["otel.status_description", "unexpected"],
])
  test(`an empty Runtime error code does not waive ${field}`, () => {
    const f = completedDelete();
    setTag(f.platform, field, value);
    assert.throws(() => inspect(f));
  });

for (const owner of [
  "agent_controller.identity_offboarding.disable",
  "RunActivity:admit_lifecycle",
])
  test(`C4 accepts the original empty read-only replay under ${owner}`, () => {
    const f = readOnlyReplay(owner),
      original = structuredClone(f.raw.trace);
    assert.equal(inspect(f).authorizationCauseVerified, true);
    assert.deepEqual(f.raw.trace, original);
  });

for (const [name, change] of [
  ["write transaction", (f) => setTag(f.BEGIN, "db.query.text", "begin")],
  [
    "write statement",
    (f) =>
      setTag(
        f.SELECT,
        "db.query.text",
        "DELETE FROM agent_controller.agent_lifecycle_operations",
      ),
  ],
  ["nonempty replay", (f) => setTag(f.SELECT, "pgx.rows_affected", 1)],
  [
    "failed statement",
    (f) => setTag(f.SELECT, "db.response.status_code", "500"),
  ],
  ["failed rollback", (f) => setTag(f.ROLLBACK, "error", true)],
  [
    "missing rollback",
    (f) => {
      f.raw.trace.spans = f.raw.trace.spans.filter((s) => s !== f.ROLLBACK);
    },
  ],
  [
    "foreign owner",
    (f) => {
      f.replay.references[0].spanID = "lifecycle.drain";
    },
  ],
])
  test(`an empty read-only replay cannot waive ${name}`, () => {
    const f = readOnlyReplay("RunActivity:admit_lifecycle");
    change(f);
    assert.throws(() => inspect(f));
  });
