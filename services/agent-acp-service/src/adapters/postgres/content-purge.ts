import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  emptyPurgeCounts,
  type ContentPurgeBatch,
  type ContentPurgeRequest,
  type ContentPurger,
  type PurgeCounts,
} from "../../domain/content-retention.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../ports/telemetry.js";
import type { PostgresKernel } from "./kernel.js";
import { RunWriteAuthority } from "./run-write-authority.js";

const SELECT_SESSIONS = `SELECT id,organization_id,agent_id FROM acp_sessions
  WHERE ($1::text IS NULL OR organization_id=$1) AND ($2::text IS NULL OR principal_id=$2)
    AND ($3::text IS NULL OR id=$3) AND ($4::timestamptz IS NULL OR (state='deleted' AND deleted_at<$4))
    AND ($5::text IS NULL OR id>$5) AND ($7::text IS NULL OR (organization_id=$7 AND agent_id=$8))
  ORDER BY id LIMIT $6 FOR UPDATE SKIP LOCKED`;
const SELECT_SESSIONS_WAIT = `SELECT id,organization_id,agent_id FROM acp_sessions
  WHERE ($1::text IS NULL OR organization_id=$1) AND ($2::text IS NULL OR principal_id=$2)
    AND ($3::text IS NULL OR id=$3) AND ($4::timestamptz IS NULL OR (state='deleted' AND deleted_at<$4))
    AND ($5::text IS NULL OR id>$5) AND ($7::text IS NULL OR (organization_id=$7 AND agent_id=$8))
  ORDER BY id LIMIT $6 FOR UPDATE`;
const LOCK_RUNS =
  "SELECT id,session_id FROM runs WHERE session_id=ANY($1::text[]) ORDER BY id FOR UPDATE";
const LOCK_TASKS =
  "SELECT id,source_run_id FROM learning_tasks WHERE source_run_id=ANY($1::text[]) ORDER BY id FOR UPDATE";
const LOCK_INTENTS =
  "SELECT request_id FROM learning_maintenance_intents WHERE task_id=ANY($1::text[]) ORDER BY request_id FOR UPDATE";
const LOCK_CANDIDATES =
  "SELECT candidate_id FROM learning_candidates WHERE task_id=ANY($1::text[]) ORDER BY candidate_id FOR UPDATE";
const GUARD = `SELECT EXISTS(SELECT 1 FROM runs r WHERE r.session_id=$1
    AND (r.state NOT IN ('completed','cancelled','failed')
      OR (r.executor_state IS DISTINCT FROM 'quiescent'
        AND NOT (r.state='failed' AND r.execution_snapshot IS NULL AND r.executor_state IS NULL))
      OR r.tool_effect_state='unknown'))
  OR EXISTS(SELECT 1 FROM tool_attempts t JOIN runs r ON r.id=t.run_id WHERE r.session_id=$1
    AND (t.state IN ('pending','in_progress') OR t.tool_effect_state='unknown'
      OR (t.source='runtime' AND NOT t.runtime_call_stopped)))
  OR EXISTS(SELECT 1 FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE r.session_id=$1
    AND t.released_at IS NULL)
  OR EXISTS(SELECT 1 FROM learning_tasks t JOIN runs r ON r.id=t.source_run_id WHERE r.session_id=$1
    AND (t.state='running'
      OR EXISTS(SELECT 1 FROM learning_model_calls m WHERE m.task_id=t.id AND m.state<>'settled')
      OR EXISTS(SELECT 1 FROM learning_maintenance_intents i WHERE i.task_id=t.id AND i.state<>'settled')
      OR EXISTS(SELECT 1 FROM learning_runtime_protections p WHERE p.task_id=t.id AND p.retired_at IS NULL)
      OR EXISTS(SELECT 1 FROM learning_candidates c WHERE c.task_id=t.id AND c.state='applied'
        AND NOT EXISTS(SELECT 1 FROM learning_changes ch WHERE ch.candidate_id=c.candidate_id
          AND ch.effect_request_id IS NOT NULL)))) AS blocked`;
const COUNTS = `SELECT cardinality($1::text[])::text AS sessions,
  cardinality($2::text[])::text AS runs,
  (SELECT count(*)::text FROM session_messages WHERE session_id=ANY($1::text[])) AS messages,
  (SELECT count(*)::text FROM tool_attempts WHERE run_id=ANY($2::text[])) AS "toolAttempts",
  cardinality($3::text[])::text AS "learningTasks",
  (SELECT count(*)::text FROM learning_evidence_items WHERE task_id=ANY($3::text[])) AS "evidenceItems",
  (SELECT count(*)::text FROM learning_evidence_snapshots WHERE task_id=ANY($3::text[])) AS "evidenceSnapshots",
  (SELECT count(*)::text FROM learning_candidates WHERE task_id=ANY($3::text[]) AND state<>'applied') AS candidates,
  (SELECT count(*)::text FROM learning_candidates WHERE task_id=ANY($3::text[]) AND state='applied') AS "publishedCandidates",
  (SELECT count(*)::text FROM learning_changes WHERE task_id=ANY($3::text[])
    OR source_session_id=ANY($1::text[]) OR source_run_id=ANY($2::text[])) AS "learningChanges"`;

const COUNT_FIELDS = [
  "sessions",
  "runs",
  "messages",
  "toolAttempts",
  "learningTasks",
  "evidenceItems",
  "evidenceSnapshots",
  "candidates",
  "publishedCandidates",
  "learningChanges",
] as const;

function counts(row: Record<string, string>): PurgeCounts {
  const parsed = emptyPurgeCounts();
  for (const field of COUNT_FIELDS) {
    const value = Number(row[field]);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("PostgreSQL purge counts are not safe nonnegative integers");
    parsed[field] = value;
  }
  return parsed;
}

export class PostgresContentPurge implements ContentPurger {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly authority: RunWriteAuthority,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
  ) {
    if (!(authority instanceof RunWriteAuthority))
      throw new TypeError("Content purge requires explicit authority");
  }

  public batch(input: ContentPurgeRequest): Promise<ContentPurgeBatch> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 500 ||
      !(input.signal instanceof AbortSignal)
    )
      return Promise.reject(new TypeError("Invalid content purge batch input"));
    const scope = this.authority.scope();
    const operation = (client: PoolClient) => this.execute(client, input, scope);
    const committed =
      scope === null
        ? this.authority.transaction(this.kernel, operation)
        : this.authority.organizationTransaction(this.kernel, scope.organizationId, operation, {
            requireLiveFenceAtCommit: true,
          });
    return committed.then((result) => {
      if (!input.dryRun && result.committed)
        this.telemetry.log("info", "acp_content_purge_batch", { ...result.batch.counts });
      return result.batch;
    });
  }

  private async execute(
    client: PoolClient,
    input: ContentPurgeRequest,
    scope: { organizationId: string; agentId: string } | null,
  ): Promise<{ batch: ContentPurgeBatch; committed: boolean }> {
    const selected = await client.query<{ id: string }>(
      input.waitForLocks === true ? SELECT_SESSIONS_WAIT : SELECT_SESSIONS,
      [
        input.organizationId ?? null,
        input.principalId ?? null,
        input.sessionId ?? null,
        input.cutoff ?? null,
        input.after ?? null,
        input.limit,
        scope?.organizationId ?? null,
        scope?.agentId ?? null,
      ],
    );
    const scanned = selected.rows.map((row) => row.id);
    const finish = (batch: ContentPurgeBatch, committed: boolean) => {
      input.signal.throwIfAborted();
      return { batch, committed };
    };
    if (scanned.length === 0)
      return finish(
        { scanned: 0, blocked: 0, counts: emptyPurgeCounts(), nextCursor: null },
        false,
      );
    const nextCursor = scanned[scanned.length - 1]!;
    const lockedRuns = await client.query<{ id: string; session_id: string }>(LOCK_RUNS, [scanned]);
    const runIds = lockedRuns.rows.map((row) => row.id);
    const lockedTasks = await client.query<{ id: string; source_run_id: string }>(LOCK_TASKS, [
      runIds,
    ]);
    const taskIds = lockedTasks.rows.map((row) => row.id);
    await client.query(LOCK_INTENTS, [taskIds]);
    await client.query(LOCK_CANDIDATES, [taskIds]);
    const blocked = new Set<string>();
    for (const sessionId of scanned) {
      const guard = await client.query<{ blocked: boolean }>(GUARD, [sessionId]);
      if (typeof guard.rows[0]?.blocked !== "boolean")
        throw new Error("PostgreSQL purge safety guard returned no verdict");
      if (guard.rows[0].blocked === true) blocked.add(sessionId);
    }
    const safeSessions = scanned.filter((id) => !blocked.has(id));
    const safeRuns = lockedRuns.rows
      .filter((row) => !blocked.has(row.session_id))
      .map((row) => row.id);
    const safeRunsSet = new Set(safeRuns);
    const safeTasks = lockedTasks.rows
      .filter((row) => safeRunsSet.has(row.source_run_id))
      .map((row) => row.id);
    const counted = await client.query<Record<string, string>>(COUNTS, [
      safeSessions,
      safeRuns,
      safeTasks,
    ]);
    const parsed = counts(counted.rows[0] ?? {});
    const batch: ContentPurgeBatch = {
      scanned: scanned.length,
      blocked: blocked.size,
      counts: parsed,
      nextCursor,
    };
    if (input.dryRun) return finish(batch, false);
    await client.query("DELETE FROM learning_apply_bases WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query(
      `UPDATE learning_candidates c SET purged_task_id=c.task_id,
       purged_effect_request_id=(SELECT ch.effect_request_id FROM learning_changes ch
         WHERE ch.candidate_id=c.candidate_id AND ch.effect_request_id IS NOT NULL
         ORDER BY ch.sequence DESC LIMIT 1),
       task_id=NULL,evidence_ids='{}'::text[],provenance_purged_at=clock_timestamp()
       WHERE c.task_id=ANY($1::text[]) AND c.state='applied'`,
      [safeTasks],
    );
    await client.query(
      `UPDATE learning_changes SET task_id=NULL,effect_request_id=NULL,source_run_id=NULL,
       source_session_id=NULL,provenance_purged_at=clock_timestamp()
       WHERE task_id=ANY($1::text[]) OR source_session_id=ANY($2::text[]) OR source_run_id=ANY($3::text[])`,
      [safeTasks, safeSessions, safeRuns],
    );
    await client.query("DELETE FROM learning_runtime_protections WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query("DELETE FROM learning_owner_recoveries WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query("DELETE FROM learning_maintenance_intents WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query("DELETE FROM learning_evidence_items WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query("DELETE FROM learning_evidence_snapshots WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query("DELETE FROM learning_model_calls WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query("DELETE FROM learning_review_attempts WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query(
      "DELETE FROM learning_source_decisions WHERE run_id=ANY($1::text[]) OR task_id=ANY($2::text[])",
      [safeRuns, safeTasks],
    );
    await client.query("DELETE FROM learning_candidates WHERE task_id=ANY($1::text[])", [
      safeTasks,
    ]);
    await client.query("DELETE FROM learning_tasks WHERE id=ANY($1::text[])", [safeTasks]);
    await client.query(
      "UPDATE learning_scan_cursors SET cursor_created_at=NULL,cursor_run_id=NULL WHERE cursor_run_id=ANY($1::text[])",
      [safeRuns],
    );
    await client.query("DELETE FROM run_owner_recoveries WHERE run_id=ANY($1::text[])", [safeRuns]);
    await client.query("DELETE FROM runs WHERE id=ANY($1::text[])", [safeRuns]);
    await client.query("DELETE FROM acp_sessions WHERE id=ANY($1::text[])", [safeSessions]);
    const committed = parsed.sessions > 0;
    if (committed)
      await client.query(
        "INSERT INTO content_purge_audit(batch_id,counts) VALUES ($1::uuid,$2::jsonb)",
        [randomUUID(), JSON.stringify(parsed)],
      );
    return finish(batch, committed);
  }
}
