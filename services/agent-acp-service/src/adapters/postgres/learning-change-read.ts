import type { PostgresKernel } from "./kernel.js";

type Scope = { organizationId: string; agentId: string; ownerId: string };
type Position = { kind: "latest" } | { kind: "after" | "before"; sequence: string };
type Row = {
  change_id: string;
  sequence: string;
  agent_id: string;
  kind: "applied";
  created_at: Date;
  package_path: string;
  before_digest: string | null;
  source_session_id: string | null;
  source_run_id: string | null;
};
export type LearningChangeItem = {
  changeId: string;
  sequence: string;
  agentId: string;
  kind: "skill_created" | "skill_updated";
  occurredAt: string;
  skillName: string;
  changeSummary: string;
  sourceSessionId?: string;
  sourceRunId?: string;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u;
const SEQUENCE = /^(?:0|[1-9][0-9]{0,18})$/u;
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;

/** Owner-scoped committed page; no candidate bytes or evidence text leave PostgreSQL. */
export class PostgresLearningChangeRead {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async page(
    scope: Scope,
    position: Position,
    limit: number,
  ): Promise<{
    sealedSequence: string;
    items: LearningChangeItem[];
    hasMoreOlder: boolean;
    hasMoreForward: boolean;
  }> {
    if (
      !ID.test(scope.organizationId) ||
      !ID.test(scope.agentId) ||
      !ID.test(scope.ownerId) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      (position.kind !== "latest" && !SEQUENCE.test(position.sequence)) ||
      (position.kind !== "latest" &&
        SEQUENCE.test(position.sequence) &&
        BigInt(position.sequence) > MAX_SEQUENCE) ||
      (position.kind === "before" && position.sequence === "0")
    )
      throw new Error("Invalid learning change page request");
    return this.kernel.transaction(async (client) => {
      const sealed =
        (
          await client.query<{ sequence: string }>(
            `SELECT coalesce(max(sequence),0)::text AS sequence FROM learning_changes
           WHERE organization_id=$1 AND agent_id=$2 AND owner_principal_id=$3`,
            [scope.organizationId, scope.agentId, scope.ownerId],
          )
        ).rows[0]?.sequence ?? "0";
      const forward = position.kind === "after";
      const rows = (
        await client.query<Row>(
          `SELECT learning_changes.change_id,learning_changes.sequence::text AS sequence,
                  learning_changes.agent_id,learning_changes.kind,learning_changes.created_at,
                  learning_changes.package_path,learning_changes.before_digest,
                  CASE WHEN source.id IS NULL THEN NULL ELSE learning_changes.source_session_id END
                    AS source_session_id,
                  CASE WHEN source.id IS NULL THEN NULL ELSE learning_changes.source_run_id END
                    AS source_run_id
           FROM learning_changes
           LEFT JOIN acp_sessions source ON source.id=learning_changes.source_session_id
             AND source.organization_id=$1 AND source.agent_id=$2
             AND source.principal_id=$3 AND source.state<>'deleted'
           WHERE learning_changes.organization_id=$1 AND learning_changes.agent_id=$2
             AND learning_changes.owner_principal_id=$3
             AND learning_changes.sequence<=$4::bigint
             AND ($5::text='latest' OR
                  ($5::text='after' AND learning_changes.sequence>$6::bigint) OR
                  ($5::text='before' AND learning_changes.sequence<$6::bigint))
           ORDER BY learning_changes.sequence ${forward ? "ASC" : "DESC"} LIMIT $7`,
          [
            scope.organizationId,
            scope.agentId,
            scope.ownerId,
            sealed,
            position.kind,
            position.kind === "latest" ? "0" : position.sequence,
            limit + 1,
          ],
        )
      ).rows;
      const more = rows.length > limit;
      const selected = rows.slice(0, limit);
      if (!forward) selected.reverse();
      return {
        sealedSequence: sealed,
        items: selected.map(toItem),
        hasMoreOlder: !forward && more,
        hasMoreForward: forward && more,
      };
    });
  }
}

function toItem(row: Row): LearningChangeItem {
  const skillName = row.package_path.slice(".antnest/skills/".length);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillName) || skillName.length > 64)
    throw new Error("Stored learning change has an invalid Skill name");
  const kind = row.before_digest === null ? "skill_created" : "skill_updated";
  return {
    changeId: row.change_id,
    sequence: row.sequence,
    agentId: row.agent_id,
    kind,
    occurredAt: row.created_at.toISOString(),
    skillName,
    changeSummary:
      kind === "skill_created" ? `已新增 Skill「${skillName}」` : `已更新 Skill「${skillName}」`,
    ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
    ...(row.source_run_id === null ? {} : { sourceRunId: row.source_run_id }),
  };
}
