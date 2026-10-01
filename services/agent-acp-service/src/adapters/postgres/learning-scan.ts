import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";

import {
  learningPolicyRevision as REVISION,
  learningPolicySchema,
  learningScopedId as SCOPED_ID,
  learningUtcTimestamp as UTC_TIMESTAMP,
  type LearningPolicy,
} from "../../domain/learning-policy.js";
import type {
  LearningScanScope,
  LearningSkipReason,
  LearningSource,
  LearningTaskClaim,
  LearningClaimCandidate,
  LearningReviewPromptVersion,
} from "../../domain/learning-scan.js";

export type {
  LearningScanScope,
  LearningSkipReason,
  LearningSource,
  LearningTaskClaim,
  LearningClaimCandidate,
} from "../../domain/learning-scan.js";

import type { PostgresKernel } from "./kernel.js";

type CursorRow = {
  owner_principal_id: string;
  policy_revision: string;
  activated_at: string;
  cursor_created_at: string | null;
  cursor_run_id: string | null;
  activation_matches?: boolean | null;
};

type RunRow = {
  id: string;
  session_id: string;
  state: string;
  created_at: string;
  updated_at: string;
};

type ClaimCandidateRow = {
  id: string;
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  source_run_id: string;
  frozen_policy: unknown;
  review_prompt_version: LearningReviewPromptVersion;
};

const frozenPolicy = learningPolicySchema.refine((policy) => policy.mode === "automatic");

function claimableTaskQuery(lock: boolean): string {
  return `SELECT t.id,t.organization_id,t.agent_id,t.owner_principal_id,
                 t.source_run_id,t.frozen_policy,t.review_prompt_version
          FROM learning_tasks t JOIN runs source ON source.id=t.source_run_id
          WHERE t.state='pending' AND source.state='completed'
            AND ($2::text IS NULL OR t.id=$2)
            AND NOT EXISTS (SELECT 1 FROM learning_tasks active WHERE active.state='running')
            AND source.updated_at<=$1::timestamptz-interval '15 seconds'
            AND NOT EXISTS (
              SELECT 1 FROM runs foreground JOIN acp_sessions s ON s.id=foreground.session_id
              WHERE s.organization_id=t.organization_id AND s.agent_id=t.agent_id
                AND (foreground.state IN ('admitting','running')
                     OR foreground.updated_at>$1::timestamptz-interval '15 seconds')
            )
            AND (t.review_prompt_version=2 OR NOT EXISTS (
              SELECT 1 FROM learning_review_attempts recent
              JOIN learning_tasks prior ON prior.id=recent.task_id
              WHERE prior.organization_id=t.organization_id AND prior.agent_id=t.agent_id
                AND recent.started_at>$1::timestamptz-interval '10 minutes'
            ))
            AND (SELECT count(*) FROM learning_review_attempts today
                 JOIN learning_tasks prior ON prior.id=today.task_id
                 WHERE prior.organization_id=t.organization_id
                   AND prior.agent_id=t.agent_id
                   AND today.started_at >=
                     (date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                   AND today.started_at <
                     (date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                       + interval '1 day')
                < COALESCE((t.frozen_policy->'limits'->>'daily_reviews')::integer,0)
            AND NOT EXISTS (
              SELECT 1 FROM learning_tasks blocked
              WHERE blocked.organization_id=t.organization_id AND blocked.agent_id=t.agent_id
                AND blocked.state='paused' AND blocked.pause_reason='worker_lost'
            )
          ORDER BY t.created_at,t.id LIMIT 1${lock ? " FOR UPDATE OF t SKIP LOCKED" : ""}`;
}

export class PostgresLearningScan {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async listScopes(
    after: LearningScanScope | null,
    limit: number,
  ): Promise<LearningScanScope[]> {
    if (after !== null) checkScope(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Learning scan scope page must contain 1–100 Agents");
    const result = await this.kernel.read<{
      organization_id: string;
      agent_id: string;
      principal_id: string;
    }>(
      `SELECT DISTINCT organization_id,agent_id,principal_id
       FROM acp_sessions
       WHERE state<>'deleted'
         AND ($1::text IS NULL OR
           (organization_id,agent_id,principal_id)>($1::text,$2::text,$3::text))
       ORDER BY organization_id,agent_id,principal_id LIMIT $4`,
      [after?.organizationId ?? null, after?.agentId ?? null, after?.ownerId ?? null, limit],
    );
    return result.rows.map((row) => ({
      organizationId: row.organization_id,
      agentId: row.agent_id,
      ownerId: row.principal_id,
    }));
  }

  public async activate(
    scope: LearningScanScope,
    policyRevision: string,
    activatedAt: string,
  ): Promise<void> {
    checkScope(scope);
    if (
      !REVISION.test(policyRevision) ||
      !UTC_TIMESTAMP.test(activatedAt) ||
      !Number.isFinite(Date.parse(activatedAt))
    )
      throw new Error("Invalid learning policy activation");
    const result = await this.kernel.query(
      `INSERT INTO learning_scan_cursors
         (organization_id,agent_id,owner_principal_id,policy_revision,activated_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id,agent_id) DO UPDATE
         SET policy_revision=EXCLUDED.policy_revision,
             cursor_created_at=CASE WHEN learning_scan_cursors.activated_at<EXCLUDED.activated_at
               THEN NULL ELSE learning_scan_cursors.cursor_created_at END,
             cursor_run_id=CASE WHEN learning_scan_cursors.activated_at<EXCLUDED.activated_at
               THEN NULL ELSE learning_scan_cursors.cursor_run_id END,
             activated_at=EXCLUDED.activated_at,updated_at=now()
       WHERE learning_scan_cursors.owner_principal_id=EXCLUDED.owner_principal_id
         AND learning_scan_cursors.activated_at<=EXCLUDED.activated_at`,
      [scope.organizationId, scope.agentId, scope.ownerId, policyRevision, activatedAt],
    );
    if (result.rowCount !== 1)
      throw new Error("Learning policy owner or activation cut conflicts with persisted scan");
  }

  public async list(scope: LearningScanScope, limit: number): Promise<LearningSource[]> {
    checkScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Learning scan page must contain 1–100 Runs");
    const cursor = await this.readCursor(scope);
    const result = await this.kernel.read<RunRow>(
      `SELECT r.id,r.session_id,r.state,r.created_at::text AS created_at,
              r.updated_at::text AS updated_at
       FROM runs r JOIN acp_sessions s ON s.id=r.session_id
       WHERE s.organization_id=$1 AND s.agent_id=$2 AND s.principal_id=$3
         AND r.created_at>$4
         AND ($5::timestamptz IS NULL OR (r.created_at,r.id)>($5::timestamptz,$6::text))
       ORDER BY r.created_at,r.id LIMIT $7`,
      [
        scope.organizationId,
        scope.agentId,
        scope.ownerId,
        cursor.activated_at,
        cursor.cursor_created_at,
        cursor.cursor_run_id,
        limit,
      ],
    );
    const ready: LearningSource[] = [];
    for (const row of result.rows) {
      if (!isTerminal(row.state)) break;
      ready.push({
        runId: row.id,
        sessionId: row.session_id,
        state: row.state,
        createdAt: row.created_at,
        finishedAt: row.updated_at,
      });
    }
    return ready;
  }

  public async recordSkip(
    scope: LearningScanScope,
    runId: string,
    reason: LearningSkipReason,
  ): Promise<void> {
    checkScope(scope);
    if (
      runId === "" ||
      ![
        "no_review_cue",
        "failed_run",
        "policy_off",
        "access_revoked",
        "source_unavailable",
      ].includes(reason)
    )
      throw new Error("Invalid learning source decision");
    await this.kernel.transaction(async (client) => {
      const cursor = await lockCursor(client, scope);
      const existing = await client.query<{
        organization_id: string;
        agent_id: string;
        owner_principal_id: string;
        reason: string;
      }>(
        "SELECT organization_id,agent_id,owner_principal_id,reason FROM learning_source_decisions WHERE run_id=$1",
        [runId],
      );
      if (existing.rows[0] !== undefined) {
        const row = existing.rows[0];
        if (
          row.organization_id !== scope.organizationId ||
          row.agent_id !== scope.agentId ||
          row.owner_principal_id !== scope.ownerId ||
          row.reason !== reason
        )
          throw new Error("Learning source decision conflict");
        return;
      }
      const next = await client.query<RunRow>(
        `SELECT r.id,r.session_id,r.state,r.created_at::text AS created_at,
                r.updated_at::text AS updated_at FROM runs r
         JOIN acp_sessions s ON s.id=r.session_id
         WHERE s.organization_id=$1 AND s.agent_id=$2 AND s.principal_id=$3
           AND r.created_at>$4
           AND ($5::timestamptz IS NULL OR (r.created_at,r.id)>($5::timestamptz,$6::text))
         ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r`,
        [
          scope.organizationId,
          scope.agentId,
          scope.ownerId,
          cursor.activated_at,
          cursor.cursor_created_at,
          cursor.cursor_run_id,
        ],
      );
      const source = next.rows[0];
      if (source?.id !== runId || !isTerminal(source.state))
        throw new Error("Learning source is not the next terminal Run");
      if (source.state === "completed" && reason === "failed_run")
        throw new Error("Completed Run cannot be classified as failed");
      if (source.state !== "completed" && reason !== "failed_run")
        throw new Error("Non-completed Run requires failed_run decision");
      await client.query(
        `INSERT INTO learning_source_decisions
        (run_id,organization_id,agent_id,owner_principal_id,policy_revision,disposition,reason)
        VALUES ($1,$2,$3,$4,$5,'skipped',$6)`,
        [runId, scope.organizationId, scope.agentId, scope.ownerId, cursor.policy_revision, reason],
      );
      await client.query(
        `UPDATE learning_scan_cursors SET cursor_created_at=$4,cursor_run_id=$5,updated_at=now()
        WHERE organization_id=$1 AND agent_id=$2 AND owner_principal_id=$3`,
        [scope.organizationId, scope.agentId, scope.ownerId, source.created_at, runId],
      );
    });
  }

  public async enqueue(
    scope: LearningScanScope,
    runId: string,
    policyInput: unknown,
    reviewPromptVersion: LearningReviewPromptVersion = 1,
  ): Promise<{ taskId: string } | null> {
    checkScope(scope);
    if (runId === "") throw new Error("Learning source Run is required");
    const policy = frozenPolicy.parse(policyInput);
    if (
      policy.organization_id !== scope.organizationId ||
      policy.agent_id !== scope.agentId ||
      policy.owner_principal_id !== scope.ownerId
    )
      throw new Error("Frozen policy scope mismatch");
    return this.kernel.transaction(async (client) => {
      const cursor = await lockCursor(client, scope, policy.activation_cut_at);
      const existing = await client.query<{
        id: string;
        organization_id: string;
        agent_id: string;
        owner_principal_id: string;
      }>(
        "SELECT id,organization_id,agent_id,owner_principal_id FROM learning_tasks WHERE source_run_id=$1 AND trigger_kind='run_completed'",
        [runId],
      );
      if (existing.rows[0] !== undefined) {
        const task = existing.rows[0];
        if (
          task.organization_id !== scope.organizationId ||
          task.agent_id !== scope.agentId ||
          task.owner_principal_id !== scope.ownerId
        )
          throw new Error("Learning task source scope conflict");
        return { taskId: task.id };
      }
      if (cursor.policy_revision !== policy.revision || cursor.activation_matches !== true)
        throw new Error("Learning policy or activation cut changed before source enqueue");
      const next = await client.query<RunRow>(
        `SELECT r.id,r.session_id,r.state,r.created_at::text AS created_at,
                r.updated_at::text AS updated_at FROM runs r
         JOIN acp_sessions s ON s.id=r.session_id
         WHERE s.organization_id=$1 AND s.agent_id=$2 AND s.principal_id=$3
           AND r.created_at>$4
           AND ($5::timestamptz IS NULL OR (r.created_at,r.id)>($5::timestamptz,$6::text))
         ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r`,
        [
          scope.organizationId,
          scope.agentId,
          scope.ownerId,
          cursor.activated_at,
          cursor.cursor_created_at,
          cursor.cursor_run_id,
        ],
      );
      const source = next.rows[0];
      if (source?.id !== runId || source.state !== "completed")
        throw new Error("Learning source is not the next completed Run");
      // The global queue count and insert must be serialized across Agents.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [2_026_092_901]);
      const queue = await client.query<{ global_count: string; agent_count: string }>(
        `SELECT count(*)::text AS global_count,
                count(*) FILTER (WHERE organization_id=$1 AND agent_id=$2)::text AS agent_count
         FROM learning_tasks WHERE state='pending'`,
        [scope.organizationId, scope.agentId],
      );
      if (Number(queue.rows[0]?.global_count) >= 100 || Number(queue.rows[0]?.agent_count) >= 2)
        return null;
      const taskId = `learn_${createHash("sha256")
        .update(JSON.stringify([scope.organizationId, scope.agentId, runId, "run_completed"]))
        .digest("hex")
        .slice(0, 32)}`;
      await client.query(
        `INSERT INTO learning_tasks
        (id,organization_id,agent_id,owner_principal_id,source_run_id,trigger_kind,
         policy_revision,frozen_policy,review_prompt_version,package_rules_version,state)
        VALUES ($1,$2,$3,$4,$5,'run_completed',$6,$7::jsonb,$8,1,'pending')`,
        [
          taskId,
          scope.organizationId,
          scope.agentId,
          scope.ownerId,
          runId,
          policy.revision,
          JSON.stringify(policy),
          reviewPromptVersion,
        ],
      );
      await client.query(
        `INSERT INTO learning_source_decisions
        (run_id,organization_id,agent_id,owner_principal_id,policy_revision,disposition,task_id)
        VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
        [runId, scope.organizationId, scope.agentId, scope.ownerId, policy.revision, taskId],
      );
      await client.query(
        `UPDATE learning_scan_cursors SET cursor_created_at=$4,cursor_run_id=$5,updated_at=now()
        WHERE organization_id=$1 AND agent_id=$2 AND owner_principal_id=$3`,
        [scope.organizationId, scope.agentId, scope.ownerId, source.created_at, runId],
      );
      return { taskId };
    });
  }

  public async previewNext(): Promise<LearningClaimCandidate | null> {
    const clock = await this.kernel.read<{ at: string }>("SELECT clock_timestamp()::text AS at");
    const next = await this.kernel.read<ClaimCandidateRow>(claimableTaskQuery(false), [
      clock.rows[0]!.at,
      null,
    ]);
    const row = next.rows[0];
    return row === undefined
      ? null
      : {
          taskId: row.id,
          organizationId: row.organization_id,
          agentId: row.agent_id,
          ownerId: row.owner_principal_id,
          sourceRunId: row.source_run_id,
          frozenPolicy: row.frozen_policy,
          reviewPromptVersion: row.review_prompt_version,
        };
  }

  public async cancelPending(
    candidate: LearningClaimCandidate,
    reason: "policy_off" | "policy_changed",
  ): Promise<boolean> {
    checkScope({
      organizationId: candidate.organizationId,
      agentId: candidate.agentId,
      ownerId: candidate.ownerId,
    });
    const frozen = frozenPolicy.parse(candidate.frozenPolicy);
    if (
      candidate.taskId.length === 0 ||
      candidate.taskId.length > 200 ||
      frozen.organization_id !== candidate.organizationId ||
      frozen.agent_id !== candidate.agentId ||
      frozen.owner_principal_id !== candidate.ownerId
    )
      throw new Error("Invalid learning claim candidate");
    const values = [
      candidate.taskId,
      candidate.organizationId,
      candidate.agentId,
      candidate.ownerId,
      frozen.revision,
      JSON.stringify(frozen),
      reason,
    ];
    const updated = await this.kernel.query(
      `UPDATE learning_tasks SET state='cancelled',cancel_reason=$7,updated_at=now()
       WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND owner_principal_id=$4
         AND policy_revision=$5 AND frozen_policy=$6::jsonb AND state='pending'`,
      values,
    );
    if (updated.rowCount === 1) return true;
    const replay = await this.kernel.read<{ state: string; cancel_reason: string }>(
      `SELECT state,cancel_reason FROM learning_tasks
       WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND owner_principal_id=$4
         AND policy_revision=$5 AND frozen_policy=$6::jsonb`,
      values.slice(0, 6),
    );
    return replay.rows[0]?.state === "cancelled" && replay.rows[0].cancel_reason === reason;
  }

  public async claimNext(
    currentPolicyInput: LearningPolicy,
    expectedTaskId: string,
  ): Promise<LearningTaskClaim | null> {
    if (expectedTaskId.length === 0 || expectedTaskId.length > 200)
      throw new Error("Invalid learning claim candidate");
    const currentPolicy = learningPolicySchema.parse(currentPolicyInput);
    return this.kernel.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [2_026_092_902]);
      const active = await client.query<{ active: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM learning_tasks WHERE state='running') AS active",
      );
      if (active.rows[0]?.active) return null;
      const clock = await client.query<{ at: string }>("SELECT clock_timestamp()::text AS at");
      const claimedAt = clock.rows[0]!.at;
      const next = await client.query<ClaimCandidateRow>(claimableTaskQuery(true), [
        claimedAt,
        expectedTaskId,
      ]);
      const row = next.rows[0];
      if (row === undefined) return null;
      const frozen = frozenPolicy.parse(row.frozen_policy);
      if (
        currentPolicy.mode !== "automatic" ||
        currentPolicy.organization_id !== row.organization_id ||
        currentPolicy.agent_id !== row.agent_id ||
        currentPolicy.owner_principal_id !== row.owner_principal_id ||
        !isDeepStrictEqual(currentPolicy, frozen)
      )
        throw new Error("Learning claim policy changed or access is unavailable");
      const claimId = randomUUID();
      const claimed = await client.query<{ generation: number }>(
        `UPDATE learning_tasks
         SET state='running',generation=generation+1,claim_id=$2,started_at=$3,updated_at=$3
         WHERE id=$1 RETURNING generation`,
        [row.id, claimId, claimedAt],
      );
      await client.query(
        `INSERT INTO learning_review_attempts (task_id,generation,started_at)
         SELECT id,generation,started_at FROM learning_tasks WHERE id=$1`,
        [row.id],
      );
      return {
        taskId: row.id,
        claimId,
        generation: claimed.rows[0]!.generation,
        organizationId: row.organization_id,
        agentId: row.agent_id,
        ownerId: row.owner_principal_id,
        sourceRunId: row.source_run_id,
        frozenPolicy: row.frozen_policy,
        reviewPromptVersion: row.review_prompt_version,
      };
    });
  }

  public async countExecutedToolRounds(scope: LearningScanScope, runId: string): Promise<number> {
    checkScope(scope);
    if (runId === "" || runId.length > 200) throw new Error("Invalid learning source Run");
    const result = await this.kernel.read<{ count: number }>(
      `WITH source AS (
         SELECT r.id FROM runs r JOIN acp_sessions s ON s.id=r.session_id
         WHERE r.id=$4 AND r.state='completed'
           AND s.organization_id=$1 AND s.agent_id=$2 AND s.principal_id=$3
       ), rounds AS (
         SELECT DISTINCT COALESCE(NULLIF(m.payload->>'responseId',''),m.id) AS round_id
         FROM source JOIN session_messages m ON m.run_id=source.id
         JOIN LATERAL jsonb_array_elements(
           CASE WHEN m.payload ? 'toolCallsJson' THEN (m.payload->>'toolCallsJson')::jsonb
                WHEN jsonb_typeof(m.payload->'toolCalls')='array' THEN m.payload->'toolCalls'
                ELSE '[]'::jsonb END
         ) AS proposed(call) ON true
         JOIN tool_attempts attempted
           ON attempted.run_id=source.id AND attempted.tool_call_id=proposed.call->>'id'
         WHERE m.kind='agent_message'
           AND attempted.state IN ('completed','failed','cancelled')
           AND attempted.started_at IS NOT NULL
         LIMIT 3
       )
       SELECT (SELECT count(*)::integer FROM rounds) AS count FROM source`,
      [scope.organizationId, scope.agentId, scope.ownerId, runId],
    );
    const count = result.rows[0]?.count;
    if (count === undefined) throw new Error("Learning source is not a completed scoped Run");
    return count;
  }

  public async hasAuthenticatedCorrectionCue(
    scope: LearningScanScope,
    runId: string,
  ): Promise<boolean> {
    checkScope(scope);
    if (runId === "" || runId.length > 200) throw new Error("Invalid learning source Run");
    const result = await this.kernel.read<{
      run_id: string;
      message_id: string | null;
      payload: unknown;
    }>(
      `SELECT r.id AS run_id,m.id AS message_id,m.payload
       FROM runs r JOIN acp_sessions s ON s.id=r.session_id
       LEFT JOIN session_messages m ON m.run_id=r.id AND m.session_id=r.session_id
                                   AND m.kind='user_message'
       WHERE r.id=$4 AND r.state='completed'
         AND s.organization_id=$1 AND s.agent_id=$2 AND s.principal_id=$3
       ORDER BY m.sequence LIMIT 4`,
      [scope.organizationId, scope.agentId, scope.ownerId, runId],
    );
    if (result.rows.length === 0) throw new Error("Learning source is not a completed scoped Run");
    return result.rows.some(({ message_id, payload }) => {
      if (
        message_id === null ||
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !("kind" in payload) ||
        payload.kind !== "user_message" ||
        !("messageId" in payload) ||
        payload.messageId !== message_id ||
        !("content" in payload) ||
        !Array.isArray(payload.content)
      )
        return false;
      return payload.content.some(
        (block: unknown) =>
          block !== null &&
          typeof block === "object" &&
          !Array.isArray(block) &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string" &&
          block.text.length <= 8_192 &&
          correctionCue.test(block.text),
      );
    });
  }

  public async hasPriorSkillRead(scope: LearningScanScope, runId: string): Promise<boolean> {
    checkScope(scope);
    if (runId === "" || runId.length > 200) throw new Error("Invalid learning source Run");
    const result = await this.kernel.read<{ used: boolean }>(
      `WITH source AS (
         SELECT r.id,r.session_id,r.created_at
         FROM runs r JOIN acp_sessions s ON s.id=r.session_id
         WHERE r.id=$4 AND r.state='completed'
           AND s.organization_id=$1 AND s.agent_id=$2 AND s.principal_id=$3
       ), prior AS (
         SELECT previous.id FROM runs previous JOIN source ON previous.session_id=source.session_id
         WHERE (previous.created_at,previous.id)<(source.created_at,source.id)
         ORDER BY previous.created_at DESC,previous.id DESC LIMIT 1
       )
       SELECT EXISTS (
         SELECT 1 FROM prior JOIN runs previous ON previous.id=prior.id
         JOIN tool_attempts attempt ON attempt.run_id=previous.id
         JOIN session_messages message ON message.run_id=previous.id
           AND message.session_id=previous.session_id
           AND message.kind='tool_call'
           AND message.payload->>'toolCallId'=attempt.tool_call_id
         CROSS JOIN LATERAL (
           SELECT (message.payload->>'argumentsJson')::jsonb AS value
         ) arguments
         WHERE previous.state='completed' AND attempt.source='runtime'
           AND attempt.tool_name='read' AND attempt.state='completed'
           AND jsonb_typeof(arguments.value->'path')='string'
           AND (
             arguments.value->>'path' ~ '^/skills/[^/]+/SKILL\\.md$'
             OR arguments.value->>'path' ~ '^(/workspace/|~/)?\\.antnest/skills/[^/]+/SKILL\\.md$'
           )
       ) AS used FROM source`,
      [scope.organizationId, scope.agentId, scope.ownerId, runId],
    );
    const used = result.rows[0]?.used;
    if (used === undefined) throw new Error("Learning source is not a completed scoped Run");
    return used;
  }

  private async readCursor(scope: LearningScanScope): Promise<CursorRow> {
    const result = await this.kernel.read<CursorRow>(
      `SELECT owner_principal_id,policy_revision,activated_at::text AS activated_at,
              cursor_created_at::text AS cursor_created_at,cursor_run_id
       FROM learning_scan_cursors WHERE organization_id=$1 AND agent_id=$2`,
      [scope.organizationId, scope.agentId],
    );
    const cursor = result.rows[0];
    if (cursor === undefined || cursor.owner_principal_id !== scope.ownerId)
      throw new Error("Learning scan scope is unavailable");
    return cursor;
  }
}

// This only spends a review slot. The authenticated message still needs source
// checks before any rule can be applied; quoted external text is not authority.
const correctionCue =
  /(?:你|您|刚才|之前|上次|前面).{0,40}(?:错(?:误|了)?|不对|有误|搞反|说反|漏了|修正|纠正|更正)|(?:不是这样|应该(?:是|改为)|请(?:修正|纠正|更正|改正))|(?:you|your|previous|earlier).{0,60}(?:wrong|incorrect|mistake|missed)|(?:correction:|actually,?\s+you)/iu;

async function lockCursor(
  client: PoolClient,
  scope: LearningScanScope,
  activationCut?: string,
): Promise<CursorRow> {
  const result = await client.query<CursorRow>(
    `SELECT owner_principal_id,policy_revision,activated_at::text AS activated_at,
            cursor_created_at::text AS cursor_created_at,cursor_run_id,
            activated_at=$3::timestamptz AS activation_matches
     FROM learning_scan_cursors WHERE organization_id=$1 AND agent_id=$2 FOR UPDATE`,
    [scope.organizationId, scope.agentId, activationCut ?? null],
  );
  const cursor = result.rows[0];
  if (cursor === undefined || cursor.owner_principal_id !== scope.ownerId)
    throw new Error("Learning scan scope is unavailable");
  return cursor;
}

function checkScope(scope: LearningScanScope): void {
  if (
    !SCOPED_ID.test(scope.organizationId) ||
    !SCOPED_ID.test(scope.agentId) ||
    !SCOPED_ID.test(scope.ownerId)
  )
    throw new Error("Learning scan scope has invalid identity");
}

function isTerminal(value: string): value is LearningSource["state"] {
  return (
    value === "completed" || value === "failed" || value === "cancelled" || value === "unresolved"
  );
}
