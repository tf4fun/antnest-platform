import type { PoolClient } from "pg";
import { learningSkillTextPackage } from "../../domain/learning-candidate-package.js";
import type {
  SkillProjection,
  SkillSourceKey,
  SkillSourceRecord,
} from "../../domain/skill-source.js";
import type { PostgresKernel } from "./kernel.js";

type Head = Omit<SkillProjection, "sequence"> & { sequence: string };

export async function recordSkillSourceProjection(
  client: PoolClient,
  input: {
    organizationId: string;
    agentId: string;
    ownerId: string;
    candidateId: string;
    skillText: string;
    contentDigest: string;
  },
): Promise<void> {
  const value = learningSkillTextPackage(input.skillText);
  if (value.targetDigest !== input.contentDigest)
    throw new Error("Skill projection content identity differs from its applied candidate");
  await client.query(
    `INSERT INTO skill_source_projections
    (organization_id,agent_id,name,owner_id,description,sequence,content_digest,active,candidate_id)
    VALUES ($1,$2,$3,$4,$5,1,$6,true,$7)
    ON CONFLICT (organization_id,agent_id,name) DO UPDATE SET
      owner_id=excluded.owner_id,description=excluded.description,
      sequence=skill_source_projections.sequence+1,content_digest=excluded.content_digest,
      active=true,candidate_id=excluded.candidate_id,failures=0,next_attempt_at=now(),updated_at=now()
    WHERE skill_source_projections.candidate_id <> excluded.candidate_id`,
    [
      input.organizationId,
      input.agentId,
      value.name,
      input.ownerId,
      value.description,
      input.contentDigest,
      input.candidateId,
    ],
  );
}

export class PostgresSkillSourceProjections {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async read(
    organizationId: string,
    key: SkillSourceKey,
  ): Promise<SkillSourceRecord | null> {
    const result = await this.kernel.read<
      Head & {
        candidate_id: string;
        skill_text: string;
        artifact: Buffer;
        artifact_digest: string;
        task_id: string;
        generation: number;
        effect_request_id: string;
        package_path: string;
      }
    >(
      `SELECT p.organization_id,p.agent_id,p.name,p.owner_id,p.description,p.sequence,p.content_digest,p.active,
      p.candidate_id,c.skill_text,c.artifact,c.artifact_digest,c.package_path,
      i.task_id,i.generation,i.request_id AS effect_request_id
      FROM skill_source_projections p
      JOIN learning_managed_skills m ON m.organization_id=p.organization_id AND m.agent_id=p.agent_id
        AND m.package_path='.antnest/skills/' || p.name AND m.owner_principal_id=p.owner_id
        AND m.state='active' AND m.origin='auto_generated' AND m.last_digest=p.content_digest
        AND m.last_candidate_id=p.candidate_id
      JOIN learning_candidates c ON c.candidate_id=p.candidate_id AND c.state='applied' AND c.target_digest=p.content_digest
      JOIN learning_changes ch ON ch.candidate_id=p.candidate_id AND ch.organization_id=p.organization_id
        AND ch.agent_id=p.agent_id AND ch.owner_principal_id=p.owner_id AND ch.after_digest=p.content_digest
      JOIN learning_maintenance_intents i ON i.request_id=ch.effect_request_id AND i.state='settled' AND i.action IN ('install','commit')
      WHERE p.organization_id=$1 AND p.agent_id=$2 AND p.name=$3 AND p.active`,
      [organizationId, key.agent_id, key.name],
    );
    const row = result.rows[0];
    if (!row) return null;
    const value = learningSkillTextPackage(row.skill_text);
    if (
      value.name !== row.name ||
      value.description !== row.description ||
      value.targetDigest !== row.content_digest ||
      value.artifactDigest !== row.artifact_digest ||
      !value.artifact.equals(row.artifact)
    )
      throw new Error("Agent-owned Skill package is inconsistent");
    return {
      projection: toProjection(row),
      packagePath: row.package_path,
      candidateId: row.candidate_id,
      taskId: row.task_id,
      generation: row.generation,
      effectRequestId: row.effect_request_id,
      package: value,
    };
  }

  public async pending(signal?: AbortSignal): Promise<SkillProjection[]> {
    signal?.throwIfAborted();
    // Reconcile only confirmed applied managed sources, never arbitrary files.
    // Lock the current managed identity so late reconciliation cannot overwrite
    // a newer apply. Candidate content remains in its existing source store.
    await this.kernel.transaction(async (client) => {
      const missing = await client.query<{
        organization_id: string;
        agent_id: string;
        owner_principal_id: string;
        last_candidate_id: string;
        last_digest: string;
        skill_text: string;
      }>(`SELECT m.organization_id,m.agent_id,m.owner_principal_id,m.last_candidate_id,m.last_digest,c.skill_text
        FROM learning_managed_skills m
        JOIN learning_candidates c ON c.candidate_id=m.last_candidate_id AND c.state='applied' AND c.target_digest=m.last_digest
        WHERE m.origin='auto_generated' AND m.state='active'
          AND EXISTS(SELECT 1 FROM learning_changes ch WHERE ch.candidate_id=c.candidate_id AND ch.organization_id=m.organization_id
            AND ch.agent_id=m.agent_id AND ch.owner_principal_id=m.owner_principal_id AND ch.after_digest=m.last_digest)
          AND NOT EXISTS(SELECT 1 FROM skill_source_projections p WHERE p.organization_id=m.organization_id
            AND p.agent_id=m.agent_id AND '.antnest/skills/' || p.name=m.package_path)
        ORDER BY m.organization_id,m.agent_id,m.package_path LIMIT 50 FOR UPDATE OF m SKIP LOCKED`);
      for (const row of missing.rows) {
        signal?.throwIfAborted();
        await recordSkillSourceProjection(client, {
          organizationId: row.organization_id,
          agentId: row.agent_id,
          ownerId: row.owner_principal_id,
          candidateId: row.last_candidate_id,
          skillText: row.skill_text,
          contentDigest: row.last_digest,
        });
      }
    });
    signal?.throwIfAborted();
    const result = await this.kernel.read<
      Head & { managed_current: boolean }
    >(`SELECT p.organization_id,p.agent_id,p.name,p.owner_id,p.description,p.sequence,p.content_digest,p.active,
      EXISTS(SELECT 1 FROM learning_managed_skills m WHERE m.organization_id=p.organization_id AND m.agent_id=p.agent_id
        AND m.package_path='.antnest/skills/' || p.name AND m.owner_principal_id=p.owner_id
        AND m.state='active' AND m.origin='auto_generated' AND m.last_digest=p.content_digest AND m.last_candidate_id=p.candidate_id) AS managed_current
      FROM skill_source_projections p WHERE p.next_attempt_at <= now()
      ORDER BY p.next_attempt_at,p.organization_id,p.agent_id,p.name LIMIT 50`);
    const items: SkillProjection[] = [];
    for (const row of result.rows) {
      const projection = toProjection(row);
      if (projection.active && !row.managed_current) await this.remove(projection);
      else items.push(projection);
    }
    return items;
  }

  public async remove(projection: SkillProjection): Promise<void> {
    await this.kernel.query(
      `UPDATE skill_source_projections SET active=false,sequence=sequence+1,
      failures=0,next_attempt_at=now(),updated_at=now()
      WHERE organization_id=$1 AND agent_id=$2 AND name=$3 AND sequence=$4 AND active`,
      [projection.organization_id, projection.agent_id, projection.name, projection.sequence],
    );
  }

  public async complete(projection: SkillProjection, delivered: boolean): Promise<void> {
    await this.kernel.query(
      `UPDATE skill_source_projections SET
      sent_sequence=CASE WHEN $5 THEN sequence ELSE sent_sequence END,
      failures=CASE WHEN $5 THEN 0 ELSE LEAST(failures+1,10) END,
      next_attempt_at=now() + CASE WHEN $5 THEN interval '60 seconds'
        ELSE LEAST(60,power(2,LEAST(failures+1,6))) * interval '1 second' END
      WHERE organization_id=$1 AND agent_id=$2 AND name=$3 AND sequence=$4`,
      [
        projection.organization_id,
        projection.agent_id,
        projection.name,
        projection.sequence,
        delivered,
      ],
    );
  }
}

function toProjection(row: Head): SkillProjection {
  const sequence = Number(row.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error("Invalid source projection sequence");
  return {
    organization_id: row.organization_id,
    agent_id: row.agent_id,
    owner_id: row.owner_id,
    name: row.name,
    description: row.description,
    sequence,
    content_digest: row.content_digest,
    active: row.active,
  };
}
