import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";

// Scope this recovery receipt to disable_runtime's completeOperation transaction.
// Successful admission transactions cannot stand in for completion.
const completionSQL = [
  "begin isolation level serializable",
  "SELECT request_id, request_digest, kind, agent_id, runtime_revision, expected_revision, source_state, source_revision, source_generation, source_spec_digest, target_generation, target_spec_digest, attempt, state, effect, inspection, error_code, error_detail, created_at, updated_at, image_reference, image_id, skill_set_id,skill_volume_name,skill_materialization,skill_manifest_digest,skill_reference_id, maintenance_verifiers, instance_authentication FROM runtime_controller.operations WHERE request_id = $1 FOR UPDATE",
  "SELECT agent_id, runtime_revision, lifecycle_state, generation, spec_digest, operation_id, updated_at FROM runtime_controller.runtime_environments WHERE agent_id = $1 FOR UPDATE",
  "UPDATE runtime_controller.operations SET state = $1, effect = $2, inspection = $3, error_code = $4, error_detail = $5, updated_at = $6 WHERE request_id = $7 AND attempt = $8 AND state IN ('running', 'unknown')",
  "UPDATE runtime_controller.runtime_environments SET runtime_revision = $1, lifecycle_state = $2, generation = $3, spec_digest = $4, operation_id = NULL, updated_at = $5 WHERE agent_id = $6 AND operation_id = $7",
  "DELETE FROM runtime_controller.skill_lifecycle_references WHERE operation_request_id=$1",
  "INSERT INTO runtime_controller.observations ( agent_id, runtime_revision, generation, spec_digest, platform_resource_id, runtime_execution_id, kind, source, diagnostic_summary, observed_at ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING sequence",
  "SELECT pg_notify('runtime_controller_observation', '')",
  "DELETE FROM runtime_controller.observations WHERE recorded_at < $1",
];
const serializationError =
  "ERROR: could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)";
const end = (span) => span.startTime + span.duration;
const query = (span) =>
  String(tag(span, "db.query.text") ?? "")
    .replace(/\s+/gu, " ")
    .trim();
const fields = (rows) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(result).length,
    rows.length,
    "duplicate completion diagnostic field",
  );
  return result;
};

function serializationFailure(span) {
  const expected = {
    error: true,
    "otel.status_code": "ERROR",
    "otel.status_description": serializationError,
  };
  const tags = fields(span.tags ?? []);
  for (const [key, value] of Object.entries(expected))
    assert.equal(tags[key], value);
  for (const [key, value] of Object.entries(tags)) {
    if (
      /^(error($|\.)|exception\.|antnest\.(error\.|outcome$|result$)|otel\.status_)/u.test(
        key,
      )
    ) {
      assert(
        Object.hasOwn(expected, key),
        "unrelated completion error metadata",
      );
      assert.equal(value, expected[key]);
    }
  }
  assert.equal(tag(span, "http.response.status_code"), undefined);
  assert.equal(
    tag(span, "pgx.rows_affected"),
    undefined,
    "failed SQL cannot report affected rows",
  );
  assert.equal(span.logs?.length, 1, "one serialization exception required");
  const event = span.logs[0];
  assert.deepEqual(fields(event.fields ?? []), {
    event: "exception",
    "exception.message": serializationError,
    "exception.type": "*pgconn.PgError",
  });
  assert(
    span.startTime <= event.timestamp && event.timestamp <= end(span),
    "exception outside failed SQL",
  );
}

export function recoveredRuntimeCompletions(trace, tree, identityServer) {
  const candidates = trace.spans.filter(
    (s) =>
      hasError(s) &&
      query(s) === completionSQL[8] &&
      tag(s, "otel.status_description") === serializationError,
  );
  const owners = new Set();
  for (const span of candidates) {
    const tx = tree.parent(span);
    assert(tx, "failed completion transaction missing");
    const owner = tree.parent(tx);
    assert(owner, "failed completion operation missing");
    owners.add(owner);
  }
  const admitted = [];
  for (const owner of owners) {
    assert.equal(tree.service(owner), "runtime-controller");
    assert.equal(owner.operationName, "runtime.lifecycle.disable_runtime");
    fields(owner.tags ?? []);
    for (const [key, value] of Object.entries({
      "span.kind": "internal",
      "antnest.operation.kind": "disable_runtime",
      "antnest.result": "completed",
      "antnest.error.class": "none",
    }))
      assert.equal(tag(owner, key), value);
    assert(
      tree.chain(owner).includes(identityServer),
      "completion outside owning Identity mutation",
    );
    const failed = candidates.filter(
      (s) => tree.parent(tree.parent(s)) === owner,
    );
    const first = Math.min(...failed.map((s) => tree.parent(s).startTime));
    const attempts = trace.spans
      .filter(
        (s) =>
          tree.parent(s) === owner &&
          s.operationName === "postgresql transaction" &&
          s.startTime >= first,
      )
      .sort((a, b) => a.startTime - b.startTime);
    assert(
      attempts.length >= 2 && attempts.length <= 10,
      "bounded completion retry and commit required",
    );
    let previousEnd = owner.startTime;
    for (const [index, tx] of attempts.entries()) {
      const rollback = index < attempts.length - 1;
      fields(tx.tags ?? []);
      assert.equal(
        tx.processID,
        owner.processID,
        "foreign completion transaction process",
      );
      assert.equal(tag(tx, "span.kind"), "internal");
      assert.equal(tag(tx, "db.system.name"), "postgresql");
      assert.equal(
        tag(tx, "antnest.transaction.outcome"),
        rollback ? "rolled_back" : "committed",
      );
      assert(
        previousEnd <= tx.startTime && end(tx) <= end(owner),
        "completion retries outside ordered operation lifetime",
      );
      previousEnd = end(tx);
      const sql = trace.spans
        .filter((s) => tree.parent(s) === tx)
        .sort((a, b) => a.startTime - b.startTime);
      assert.deepEqual(
        sql.map(query),
        [...completionSQL, rollback ? "rollback" : "commit"],
        "exact completion SQL sequence required",
      );
      let sqlEnd = tx.startTime;
      for (const [position, s] of sql.entries()) {
        fields(s.tags ?? []);
        assert.equal(
          s.processID,
          owner.processID,
          "foreign completion SQL process",
        );
        assert.equal(tag(s, "span.kind"), "client");
        assert.equal(tag(s, "db.system.name"), "postgresql");
        assert.equal(tag(s, "db.namespace"), "antnest_runtime_controller");
        const operation = query(s).split(" ")[0].toUpperCase();
        assert.equal(s.operationName, operation);
        assert.equal(tag(s, "db.operation.name"), operation);
        assert(
          sqlEnd <= s.startTime && end(s) <= end(tx),
          "completion SQL outside serial transaction lifetime",
        );
        sqlEnd = end(s);
        if (rollback && position === 8) {
          serializationFailure(s);
          admitted.push(s);
        } else {
          assert(!hasError(s), "completion recovery contains another error");
          const rows = tag(s, "pgx.rows_affected");
          assert(
            Number.isSafeInteger(rows) && rows >= 0,
            "completion affected-row receipt missing",
          );
          const exact = [0, 1, 1, 1, 1, undefined, 1, 1, undefined, 0][
            position
          ];
          if (exact !== undefined)
            assert.equal(rows, exact, "completion SQL did not apply");
        }
      }
    }
    assert(
      failed.every((s) => admitted.includes(s)),
      "unrecovered completion failure",
    );
  }
  return admitted;
}
