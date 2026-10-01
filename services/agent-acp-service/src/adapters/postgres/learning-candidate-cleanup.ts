import { createHash } from "node:crypto";
import type { LearningCleanupItem } from "../../application/learning-candidate-cleanup.js";
import type { LearningReviewPromptVersion } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";

/** Terminal tasks remain discoverable after restart; unresolved effects retain their bytes. */
export class PostgresLearningCandidateCleanup {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async next(): Promise<LearningCleanupItem | null> {
    return this.kernel.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        claim_id: string;
        generation: number;
        organization_id: string;
        agent_id: string;
        owner_principal_id: string;
        source_run_id: string;
        frozen_policy: Record<string, unknown>;
        review_prompt_version: LearningReviewPromptVersion;
        request_id: string;
        receipt: { storage_key: string; observed_digest: string };
        request_facts: { package_path: string };
      }>(`SELECT task.*, preparation.request_id, preparation.receipt, preparation.request_facts
        FROM learning_tasks task JOIN learning_maintenance_intents preparation
          ON preparation.task_id=task.id
        WHERE task.state IN ('completed','failed','cancelled')
          AND preparation.action='prepare' AND preparation.state='settled'
          AND preparation.receipt->>'outcome'='prepared'
          AND NOT EXISTS (SELECT 1 FROM learning_maintenance_intents effect
            WHERE effect.task_id=task.id AND effect.action<>'release' AND effect.state<>'settled')
          AND NOT EXISTS (SELECT 1 FROM learning_maintenance_intents cleanup
            WHERE cleanup.task_id=task.id AND cleanup.action='release'
              AND cleanup.request_facts->>'storage_key'=preparation.receipt->>'storage_key'
              AND cleanup.state='settled')
        ORDER BY task.updated_at, task.id LIMIT 1`);
      const row = result.rows[0];
      if (!row) return null;
      return {
        claim: {
          taskId: row.id,
          claimId: row.claim_id,
          generation: row.generation,
          organizationId: row.organization_id,
          agentId: row.agent_id,
          ownerId: row.owner_principal_id,
          sourceRunId: row.source_run_id,
          frozenPolicy: row.frozen_policy,
          reviewPromptVersion: row.review_prompt_version,
        },
        requestId: createHash("sha256")
          .update(JSON.stringify(["learning-release-v1", row.request_id, row.receipt.storage_key]))
          .digest("hex"),
        storageKey: row.receipt.storage_key,
        packagePath: row.request_facts.package_path,
        expectedDigest: row.receipt.observed_digest,
      };
    });
  }
}
