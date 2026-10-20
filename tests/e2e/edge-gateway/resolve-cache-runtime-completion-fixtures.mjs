import { recoveryHTTPFixture } from "./resolve-cache-recovery-http-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

// Public SQL text from Runtime completeOperation, never query parameters.
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

export function runtimeCompletionFixture(action = "deactivate", retries = 1) {
  const f = recoveryHTTPFixture();
  const p = f.parts.find((p) => p.action === action);
  p.trace.processes.controller = { serviceName: "runtime-controller" };
  const owner = p.add(
    "runtime-owner",
    "controller",
    p.server,
    {
      "span.kind": "internal",
      "antnest.operation.kind": "disable_runtime",
      "antnest.result": "completed",
      "antnest.error.class": "none",
    },
    "runtime.lifecycle.disable_runtime",
  );
  owner.startTime = 1030000;
  owner.duration = (retries + 1) * 3000 + 100;
  const attempts = [];
  for (let n = 0; n <= retries; n++) {
    const failed = n < retries;
    const tx = p.add(
      `runtime-tx-${n}`,
      "controller",
      owner,
      {
        "span.kind": "internal",
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": failed ? "rolled_back" : "committed",
      },
      "postgresql transaction",
    );
    tx.startTime = owner.startTime + 100 + n * 3000;
    tx.duration = 2100;
    const sql = [...completionSQL, failed ? "rollback" : "commit"].map(
      (query, i) => {
        const error = failed && i === 8;
        const operation = query.split(" ")[0].toUpperCase();
        const span = p.add(
          `runtime-sql-${n}-${i}`,
          "controller",
          tx,
          {
            "span.kind": "client",
            "db.system.name": "postgresql",
            "db.namespace": "antnest_runtime_controller",
            "db.operation.name": operation,
            "db.query.text": query,
            ...(error
              ? {
                  error: true,
                  "otel.status_code": "ERROR",
                  "otel.status_description": serializationError,
                }
              : { "pgx.rows_affected": [0, 1, 1, 1, 1, 0, 1, 1, 0, 0][i] }),
          },
          operation,
        );
        span.startTime = tx.startTime + 100 + i * 200;
        span.duration = 50;
        if (error)
          span.logs = [
            {
              timestamp: span.startTime,
              fields: fields({
                event: "exception",
                "exception.type": "*pgconn.PgError",
                "exception.message": serializationError,
              }),
            },
          ];
        return span;
      },
    );
    attempts.push({ tx, sql });
  }
  return { ...f, p, owner, attempts, error: attempts[0].sql[8] };
}
