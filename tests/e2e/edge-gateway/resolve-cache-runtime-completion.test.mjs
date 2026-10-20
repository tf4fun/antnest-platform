import assert from "node:assert/strict";
import test from "node:test";
import { inspectRecoveryHTTP } from "./resolve-cache-recovery-http.mjs";
import { runtimeCompletionFixture } from "./resolve-cache-runtime-completion-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

const inspect = (f) =>
  inspectRecoveryHTTP(f.evidence, f, ["private-http-canary"]);
const remove = (f, s) => {
  f.p.trace.spans = f.p.trace.spans.filter((x) => x !== s);
};

for (const retries of [1, 2, 9])
  test(`deactivation retains ${retries} recovered serialization errors with their exact owning transactions`, () => {
    const f = runtimeCompletionFixture("deactivate", retries);
    const before = JSON.stringify([...f.traces.values()]);
    const result = inspect(f);
    assert.equal(result.status, "passed");
    assert.equal(result.error_spans, 38 + retries);
    assert.equal(result.strict_trace, "failed");
    assert.deepEqual(
      result.owned_error_spans.filter(
        (r) => r.reason === "runtime-completion-serialization-recovered",
      ),
      f.attempts
        .slice(0, -1)
        .map(({ sql }) => ({
          trace_id: f.p.trace.traceID,
          span_id: sql[8].spanID,
          reason: "runtime-completion-serialization-recovered",
        })),
    );
    assert.equal(JSON.stringify([...f.traces.values()]), before);
  });

for (const [name, mutate] of [
  [
    "foreign service",
    (f) => {
      f.p.trace.processes.controller.serviceName = "identity-service";
    },
  ],
  [
    "foreign SQL process",
    (f) => {
      f.p.trace.processes.other = { serviceName: "runtime-controller" };
      f.error.processID = "other";
    },
  ],
  [
    "foreign transaction process",
    (f) => {
      f.attempts[1].tx.processID = "identity";
    },
  ],
  [
    "wrong operation",
    (f) => {
      f.owner.operationName = "runtime.lifecycle.enable_runtime";
    },
  ],
  [
    "wrong operation kind",
    (f) => setTag(f.owner, "antnest.operation.kind", "enable_runtime"),
  ],
  ["failed owner", (f) => setTag(f.owner, "antnest.result", "failed")],
  ["owner error", (f) => setTag(f.owner, "antnest.error.class", "storage")],
  [
    "unrelated ancestry",
    (f) => {
      f.owner.references[0].spanID = f.p.root.spanID;
    },
  ],
  [
    "unrelated transaction",
    (f) => {
      f.attempts[1].tx.references[0].spanID = f.p.server.spanID;
    },
  ],
  [
    "error outside transaction",
    (f) => {
      f.error.references[0].spanID = f.owner.spanID;
    },
  ],
  ["missing rollback", (f) => remove(f, f.attempts[0].sql[9])],
  [
    "commit on failure",
    (f) => {
      const s = f.attempts[0].sql[9];
      s.operationName = "COMMIT";
      setTag(s, "db.operation.name", "COMMIT");
      setTag(s, "db.query.text", "commit");
    },
  ],
  [
    "failed transaction marked committed",
    (f) => setTag(f.attempts[0].tx, "antnest.transaction.outcome", "committed"),
  ],
  ["missing retry commit", (f) => remove(f, f.attempts[1].sql[9])],
  [
    "retry rolled back",
    (f) =>
      setTag(f.attempts[1].tx, "antnest.transaction.outcome", "rolled_back"),
  ],
  ["retry commit error", (f) => setTag(f.attempts[1].sql[9], "error", true)],
  [
    "success before failure",
    (f) => {
      f.attempts[1].tx.startTime = f.attempts[0].tx.startTime - 1;
    },
  ],
  [
    "overlapping retry",
    (f) => {
      f.attempts[1].tx.startTime = f.attempts[0].tx.startTime + 1;
    },
  ],
  [
    "transaction outside operation",
    (f) => {
      f.owner.duration = 1;
    },
  ],
  [
    "SQL outside transaction",
    (f) => {
      f.error.startTime += 3000;
    },
  ],
  [
    "out of order SQL",
    (f) => {
      f.attempts[1].sql[3].startTime = f.attempts[1].sql[2].startTime;
    },
  ],
  ["missing completion write", (f) => remove(f, f.attempts[1].sql[3])],
  [
    "wrong deletion table",
    (f) =>
      setTag(
        f.error,
        "db.query.text",
        "DELETE FROM api_tokens WHERE recorded_at < $1",
      ),
  ],
  [
    "wrong deletion predicate",
    (f) =>
      setTag(
        f.error,
        "db.query.text",
        "DELETE FROM runtime_controller.observations",
      ),
  ],
  [
    "wrong retry SQL",
    (f) =>
      setTag(
        f.attempts[1].sql[8],
        "db.query.text",
        "DELETE FROM runtime_controller.observations",
      ),
  ],
  [
    "wrong driver name",
    (f) => {
      f.error.operationName = "SELECT";
    },
  ],
  [
    "wrong database",
    (f) => setTag(f.error, "db.namespace", "antnest_identity"),
  ],
  [
    "nonserializable begin",
    (f) => setTag(f.attempts[1].sql[0], "db.query.text", "begin"),
  ],
  [
    "unapplied operation update",
    (f) => setTag(f.attempts[1].sql[3], "pgx.rows_affected", 0),
  ],
  [
    "other SQLSTATE",
    (f) => setTag(f.error, "otel.status_description", "SQLSTATE 40P01"),
  ],
  [
    "different exception type",
    (f) => {
      f.error.logs[0].fields = fields({
        event: "exception",
        "exception.type": "Error",
        "exception.message": "SQLSTATE 40001",
      });
    },
  ],
  [
    "contradictory exception",
    (f) => {
      f.error.logs[0].fields.find((x) => x.key === "exception.message").value =
        "failed";
    },
  ],
  [
    "second exception",
    (f) => {
      f.error.logs.push(structuredClone(f.error.logs[0]));
    },
  ],
  ["unknown diagnostic tag", (f) => setTag(f.error, "error.type", "foreign")],
  [
    "unknown diagnostic field",
    (f) => {
      f.error.logs[0].fields.push({ key: "error.type", value: "foreign" });
    },
  ],
  [
    "duplicate diagnostic tag",
    (f) => {
      f.error.tags.push({ key: "error", value: false });
    },
  ],
  [
    "exception outside SQL",
    (f) => {
      f.error.logs[0].timestamp += 10000;
    },
  ],
  [
    "unrelated error remains blocking",
    (f) => setTag(f.p.server, "error", true),
  ],
])
  test(`recovered completion rejects ${name}`, () => {
    const f = runtimeCompletionFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const action of ["role", "restore", "password", "logout"])
  test(`serialization allowance does not apply to ${action}`, () => {
    assert.throws(() => inspect(runtimeCompletionFixture(action)));
  });
