import { createHash } from "node:crypto";

import {
  checkAutomaticCitationFloor,
  type LearningRuleProposal,
} from "../../domain/learning-citation-guard.js";
import {
  digestLearningEvidence,
  type LearningEvidence,
  type LearningEvidenceItem,
} from "../../domain/learning-evidence.js";
import { learningScopedId } from "../../domain/learning-policy.js";
import type { LearningScanScope, LearningTaskClaim } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";

const MAX_USER_CHARS = 4_096;
const MAX_TOOL_ATTEMPTS = 8;
const MAX_TOOL_OUTPUT_CHARS = 512;

type UserRow = {
  id: string;
  payload_kind: string | null;
  payload_message_id: string | null;
  content_is_array: boolean;
  text: string;
  has_more_blocks: boolean;
};
type ToolRow = {
  id: string;
  tool_call_id: string;
  source: string;
  tool_name: string;
  state: string;
  tool_effect_state: string;
  output_text: string;
  output_has_more_blocks: boolean;
};

export class PostgresLearningEvidence {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async checkRecordedCitationFloor(
    claim: LearningTaskClaim,
    rules: unknown,
  ): Promise<LearningRuleProposal[]> {
    return checkAutomaticCitationFloor(rules, await this.loadRecorded(claim));
  }

  public async loadRecorded(claim: LearningTaskClaim): Promise<LearningEvidence> {
    const snapshots = await this.kernel.read<{
      source_run_id: string;
      digest: string;
      truncated: boolean;
    }>(
      `SELECT saved.source_run_id,saved.digest,saved.truncated
       FROM learning_evidence_snapshots saved
       JOIN learning_tasks task ON task.id=saved.task_id
       WHERE task.id=$1 AND task.organization_id=$2 AND task.agent_id=$3
         AND task.owner_principal_id=$4 AND task.source_run_id=$5
         AND task.state='running' AND task.claim_id=$6 AND task.generation=$7`,
      [
        claim.taskId,
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        claim.sourceRunId,
        claim.claimId,
        claim.generation,
      ],
    );
    const saved = snapshots.rows[0];
    if (saved === undefined) throw new Error("Learning evidence snapshot is unavailable");
    const rows = await this.kernel.read<LearningEvidenceItem & { ordinal: number }>(
      `SELECT ordinal,evidence_id AS "evidenceId",source_id AS "sourceId",kind,scope,text
       FROM learning_evidence_items WHERE task_id=$1 ORDER BY ordinal`,
      [claim.taskId],
    );
    const items: LearningEvidenceItem[] = rows.rows.map((row, index) => {
      if (
        row.ordinal !== index ||
        !["authenticated_user", "observed_execution", "untrusted_material"].includes(row.kind) ||
        !["user_prompt", "tool_attempt", "tool_output"].includes(row.scope)
      )
        throw new Error("Learning evidence item is invalid");
      return {
        evidenceId: row.evidenceId,
        sourceId: row.sourceId,
        kind: row.kind,
        scope: row.scope,
        text: row.text,
      };
    });
    const evidence = { sourceRunId: saved.source_run_id, items, truncated: saved.truncated };
    if (digestLearningEvidence(evidence) !== saved.digest)
      throw new Error("Learning evidence snapshot digest mismatch");
    return evidence;
  }

  public async readAndRecord(claim: LearningTaskClaim): Promise<LearningEvidence> {
    const scope: LearningScanScope = {
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    };
    const evidence = await this.read(scope, claim.sourceRunId);
    const digest = digestLearningEvidence(evidence);
    await this.kernel.transaction(async (client) => {
      const task = await client.query<{
        organization_id: string;
        agent_id: string;
        owner_principal_id: string;
        source_run_id: string;
        state: string;
        claim_id: string | null;
        generation: number;
      }>(
        `SELECT organization_id,agent_id,owner_principal_id,source_run_id,
                state,claim_id,generation
         FROM learning_tasks WHERE id=$1 FOR UPDATE`,
        [claim.taskId],
      );
      const row = task.rows[0];
      if (
        row === undefined ||
        row.organization_id !== claim.organizationId ||
        row.agent_id !== claim.agentId ||
        row.owner_principal_id !== claim.ownerId ||
        row.source_run_id !== claim.sourceRunId ||
        row.state !== "running" ||
        row.claim_id !== claim.claimId ||
        row.generation !== claim.generation
      )
        throw new Error("Learning evidence claim is unavailable");
      const existing = await client.query<{ source_run_id: string; digest: string }>(
        "SELECT source_run_id,digest FROM learning_evidence_snapshots WHERE task_id=$1",
        [claim.taskId],
      );
      if (existing.rows[0] !== undefined) {
        if (
          existing.rows[0].source_run_id !== evidence.sourceRunId ||
          existing.rows[0].digest !== digest
        )
          throw new Error("Learning evidence snapshot changed after recording");
        return;
      }
      await client.query(
        `INSERT INTO learning_evidence_snapshots
          (task_id,source_run_id,claim_id,generation,digest,truncated)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          claim.taskId,
          evidence.sourceRunId,
          claim.claimId,
          claim.generation,
          digest,
          evidence.truncated,
        ],
      );
      for (const [ordinal, entry] of evidence.items.entries())
        await client.query(
          `INSERT INTO learning_evidence_items
            (task_id,ordinal,evidence_id,source_id,kind,scope,text)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            claim.taskId,
            ordinal,
            entry.evidenceId,
            entry.sourceId,
            entry.kind,
            entry.scope,
            entry.text,
          ],
        );
    });
    return evidence;
  }

  public async read(scope: LearningScanScope, runId: string): Promise<LearningEvidence> {
    if (
      !learningScopedId.test(scope.organizationId) ||
      !learningScopedId.test(scope.agentId) ||
      !learningScopedId.test(scope.ownerId) ||
      runId.length === 0 ||
      runId.length > 200
    )
      throw new Error("Invalid learning evidence scope");
    const users = await this.kernel.read<UserRow>(
      `SELECT m.id,m.payload->>'kind' AS payload_kind,
              m.payload->>'messageId' AS payload_message_id,
              jsonb_typeof(m.payload->'content')='array' AS content_is_array,
              COALESCE((SELECT left(string_agg(left(part.value->>'text',$5),chr(10)
                  ORDER BY part.ordinality),$5)
                FROM jsonb_array_elements(CASE
                  WHEN jsonb_typeof(m.payload->'content')='array' THEN m.payload->'content'
                  ELSE '[]'::jsonb END) WITH ORDINALITY AS part(value,ordinality)
                WHERE part.ordinality<=16 AND part.value->>'type'='text'
                  AND jsonb_typeof(part.value->'text')='string'), '') AS text,
              CASE WHEN jsonb_typeof(m.payload->'content')='array'
                THEN jsonb_array_length(m.payload->'content')>16 ELSE false END AS has_more_blocks
       FROM runs r JOIN acp_sessions s ON s.id=r.session_id
       JOIN session_messages m ON m.run_id=r.id AND m.session_id=r.session_id
       WHERE r.id=$4 AND r.state='completed' AND r.tool_effect_state IN ('none','settled')
         AND s.organization_id=$1 AND s.agent_id=$2 AND s.principal_id=$3
         AND m.kind='user_message'
       ORDER BY m.sequence LIMIT 2`,
      [scope.organizationId, scope.agentId, scope.ownerId, runId, MAX_USER_CHARS + 1],
    );
    if (users.rows.length !== 1)
      throw new Error("Completed learning source has no unique user input");
    const user = users.rows[0]!;
    if (
      user.payload_kind !== "user_message" ||
      user.payload_message_id !== user.id ||
      user.content_is_array !== true
    )
      throw new Error("Completed learning source user input is invalid");
    const prompt = user.text;

    let truncated = prompt.length > MAX_USER_CHARS || user.has_more_blocks;
    const items: LearningEvidenceItem[] = [];
    if (prompt !== "")
      items.push(
        item(runId, user.id, "authenticated_user", "user_prompt", prompt.slice(0, MAX_USER_CHARS)),
      );

    const tools = await this.kernel.read<ToolRow>(
      `SELECT t.id,left(t.tool_call_id,201) AS tool_call_id,t.source,
              left(t.tool_name,201) AS tool_name,t.state,t.tool_effect_state,
              COALESCE((SELECT left(string_agg(left(part.value->>'text',$6),chr(10)
                  ORDER BY part.ordinality),$6)
                FROM jsonb_array_elements(CASE
                  WHEN jsonb_typeof(t.result_summary)='array' THEN t.result_summary
                  ELSE '[]'::jsonb END) WITH ORDINALITY AS part(value,ordinality)
                WHERE part.ordinality<=16 AND part.value->>'type'='text'
                  AND jsonb_typeof(part.value->'text')='string'), '') AS output_text,
              CASE WHEN jsonb_typeof(t.result_summary)='array'
                THEN jsonb_array_length(t.result_summary)>16 ELSE false END AS output_has_more_blocks
       FROM tool_attempts t JOIN runs r ON r.id=t.run_id
       JOIN acp_sessions s ON s.id=r.session_id
       WHERE r.id=$4 AND r.state='completed'
         AND s.organization_id=$1 AND s.agent_id=$2 AND s.principal_id=$3
       ORDER BY t.started_at,t.id LIMIT $5`,
      [
        scope.organizationId,
        scope.agentId,
        scope.ownerId,
        runId,
        MAX_TOOL_ATTEMPTS + 1,
        MAX_TOOL_OUTPUT_CHARS + 1,
      ],
    );
    truncated ||= tools.rows.length > MAX_TOOL_ATTEMPTS;
    for (const tool of tools.rows.slice(0, MAX_TOOL_ATTEMPTS)) {
      items.push(
        item(
          runId,
          tool.id,
          "observed_execution",
          "tool_attempt",
          JSON.stringify({
            toolCallId: tool.tool_call_id.slice(0, 200),
            source: tool.source.slice(0, 32),
            toolName: tool.tool_name.slice(0, 200),
            state: tool.state,
            effectState: tool.tool_effect_state,
          }),
        ),
      );
      const output = tool.output_text;
      if (output === "") continue;
      truncated ||= output.length > MAX_TOOL_OUTPUT_CHARS || tool.output_has_more_blocks;
      items.push(
        item(
          runId,
          tool.id,
          "untrusted_material",
          "tool_output",
          output.slice(0, MAX_TOOL_OUTPUT_CHARS),
        ),
      );
    }
    return { sourceRunId: runId, items, truncated };
  }
}

function item(
  runId: string,
  sourceId: string,
  kind: LearningEvidenceItem["kind"],
  scope: LearningEvidenceItem["scope"],
  text: string,
): LearningEvidenceItem {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, sourceId, kind, scope]))
    .digest("hex");
  return { evidenceId: `evidence_${digest.slice(0, 32)}`, sourceId, kind, scope, text };
}
