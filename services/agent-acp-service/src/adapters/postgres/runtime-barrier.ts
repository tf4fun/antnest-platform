import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DomainError } from "../../domain/errors.js";
import {
  parsePublicExecutionConfiguration,
  type PublicExecutionConfiguration,
} from "../../domain/execution-configuration.js";
import type {
  RuntimeBarrierReader,
  RuntimeBarrierScope,
  RuntimeBarrierState,
} from "../../ports/runtime-barrier.js";
import type { PostgresKernel } from "./kernel.js";

// Two-int advisory locks are separate from the bigint migration, worker and
// learning locks. A hash collision only serializes two organizations.
const RUNTIME_BARRIER_LOCK_NAMESPACE = 0x41425243;

// All uses bind this expression to the original Run, including temporary
// protection whose cleanup must not be inferred from Tool effect history.
const protectedRun = `(
  EXISTS (
    SELECT 1 FROM tool_attempts AS attempt
    WHERE attempt.run_id = run.id
      AND attempt.source = 'runtime' AND NOT attempt.runtime_call_stopped
  )
  OR EXISTS (
    SELECT 1 FROM temporary_skill_scopes AS temporary
    WHERE temporary.run_id = run.id AND temporary.released_at IS NULL
  )
)`;

export async function lockRuntimeBarrierOrganization(
  client: PoolClient,
  organizationId: string,
): Promise<void> {
  // Callers acquire this transaction lock before existing Session/Run/config
  // row locks and keep it through publication, finish or scope cleanup commit.
  await client.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))", [
    RUNTIME_BARRIER_LOCK_NAMESPACE,
    organizationId,
  ]);
}

export async function createRuntimeBarrierForRun(client: PoolClient, runId: string): Promise<void> {
  // The owning finish transaction calls this only after its first transition
  // from running. Idempotent terminal retries must not recreate retired cycles.
  await client.query(
    `INSERT INTO runtime_barrier_cycles (
       barrier_id, organization_id, agent_id, runtime_revision, runtime_execution_id
     )
     SELECT $2, session.organization_id, session.agent_id,
       run.execution_snapshot->'runtime'->>'revision',
       run.execution_snapshot->'runtime'->>'executionId'
     FROM runs AS run
     JOIN acp_sessions AS session ON session.id = run.session_id
     WHERE run.id = $1
       AND run.state IN ('completed', 'cancelled', 'failed', 'unresolved')
       AND run.terminal_class = run.state AND run.executor_state = 'quiescent'
       AND ${protectedRun}
       AND NOT EXISTS (
         SELECT 1 FROM execution_configurations AS configuration
         CROSS JOIN LATERAL jsonb_array_elements(configuration.configuration->'agents')
           AS current_agent(value)
         WHERE configuration.organization_id = session.organization_id
           AND current_agent.value->>'agent_id' = session.agent_id
           AND current_agent.value->>'accepting_runs' = 'true'
           AND current_agent.value->'runtime'->>'runtime_revision' IS NOT NULL
           AND current_agent.value->'runtime'->>'runtime_revision'
             <> run.execution_snapshot->'runtime'->>'revision'
       )
     ON CONFLICT (organization_id, agent_id, runtime_revision)
       WHERE retired_at IS NULL DO NOTHING`,
    [runId, randomUUID()],
  );
}

export async function retireClearedRuntimeBarriers(
  client: PoolClient,
  scope: { organizationId: string; agentId: string; runtimeRevision: string },
): Promise<void> {
  // Every Run in the binding participates, not only the Run whose snapshot
  // originally supplied the cycle's execution ID.
  await client.query(
    `UPDATE runtime_barrier_cycles AS barrier SET retired_at = now()
     WHERE barrier.organization_id = $1 AND barrier.agent_id = $2
       AND barrier.runtime_revision = $3 AND barrier.retired_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM runs AS run
         JOIN acp_sessions AS session ON session.id = run.session_id
         WHERE session.organization_id = barrier.organization_id
           AND session.agent_id = barrier.agent_id
           AND run.execution_snapshot->'runtime'->>'revision' = barrier.runtime_revision
           AND ${protectedRun}
       )`,
    [scope.organizationId, scope.agentId, scope.runtimeRevision],
  );
}

export async function retireReplacedRuntimeBarriers(
  client: PoolClient,
  incoming: PublicExecutionConfiguration,
): Promise<void> {
  // Only a successfully saved replacement publication promises isolation
  // of the old revision. Closure, removal and same-revision changes do not.
  await client.query(
    `UPDATE runtime_barrier_cycles AS barrier SET retired_at = now()
     FROM jsonb_array_elements($2::jsonb) AS incoming_agent(value)
     WHERE barrier.organization_id = $1 AND barrier.retired_at IS NULL
       AND barrier.agent_id = incoming_agent.value->>'agent_id'
       AND incoming_agent.value->>'accepting_runs' = 'true'
       AND incoming_agent.value->>'runtime_revision' IS NOT NULL
       AND incoming_agent.value->>'runtime_revision' <> barrier.runtime_revision`,
    [
      incoming.organization_id,
      JSON.stringify(
        incoming.agents.map((agent) => ({
          agent_id: agent.agent_id,
          accepting_runs: agent.accepting_runs,
          runtime_revision: agent.runtime?.runtime_revision ?? null,
        })),
      ),
    ],
  );
}

type BarrierRow = {
  configuration: unknown;
  barrier_id: string | null;
  runtime_execution_id: string | null;
  has_nonterminal: boolean;
  has_terminal_protection: boolean;
};

export class PostgresRuntimeBarrierReader implements RuntimeBarrierReader {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async readCurrentBarrier(
    scope: RuntimeBarrierScope,
    signal?: AbortSignal,
  ): Promise<RuntimeBarrierState> {
    // One statement snapshot binds the public configuration, durable cycle and
    // any outstanding local execution. A storage/configuration failure is not
    // evidence that the binding is clear.
    const result = await this.kernel.read<BarrierRow>(
      `SELECT configuration.configuration, barrier.barrier_id, barrier.runtime_execution_id,
         EXISTS (
           SELECT 1 FROM runs AS run
           JOIN acp_sessions AS session ON session.id = run.session_id
           WHERE session.organization_id = configuration.organization_id
             AND session.agent_id = $2 AND run.state IN ('admitting', 'running')
             AND (run.state = 'admitting'
               OR run.execution_snapshot->'runtime'->>'revision' = $3)
         ) AS has_nonterminal,
         EXISTS (
           SELECT 1 FROM runs AS run
           JOIN acp_sessions AS session ON session.id = run.session_id
           WHERE session.organization_id = configuration.organization_id
             AND session.agent_id = $2
             AND run.execution_snapshot->'runtime'->>'revision' = $3
             AND run.state IN ('completed', 'cancelled', 'failed', 'unresolved')
             AND run.terminal_class = run.state AND run.executor_state = 'quiescent'
             AND ${protectedRun}
         ) AS has_terminal_protection
       FROM execution_configurations AS configuration
       LEFT JOIN runtime_barrier_cycles AS barrier
         ON barrier.organization_id = configuration.organization_id
         AND barrier.agent_id = $2 AND barrier.runtime_revision = $3
         AND barrier.retired_at IS NULL
       WHERE configuration.organization_id = $1`,
      [scope.organizationId, scope.agentId, scope.expectedRuntimeRevision],
      signal,
    );
    const current = result.rows[0];
    if (current === undefined) {
      // The control query checks initialized, available service ownership before
      // reading. A successful snapshot with no row is absence, not a cold source.
      throw new DomainError("not_found", "Runtime barrier scope was not found");
    }
    const configuration = parsePublicExecutionConfiguration(current.configuration);
    if (configuration.organization_id !== scope.organizationId) {
      throw new DomainError(
        "configuration_conflict",
        "Runtime barrier scope conflicts with configuration",
      );
    }
    const agent = configuration.agents.find((value) => value.agent_id === scope.agentId);
    if (agent === undefined) {
      throw new DomainError("not_found", "Runtime barrier scope was not found");
    }
    const runtimeRevision = agent.runtime?.runtime_revision;
    if (runtimeRevision === undefined || runtimeRevision !== scope.expectedRuntimeRevision) {
      throw new DomainError(
        "configuration_conflict",
        "Runtime barrier scope conflicts with configuration",
      );
    }
    if (current.barrier_id === null && current.runtime_execution_id === null) {
      // Facts from a replaced revision are outside this current binding. Within
      // it, quiescent protection and its cycle commit together; a missing cycle
      // is corruption, never evidence of a clear Runtime or a reason to mint ID.
      if (!current.has_nonterminal && current.has_terminal_protection) {
        throw new Error("Stored Runtime barrier projection is missing");
      }
      return { runtimeRevision, barrier: null };
    }
    if (
      !validStoredIdentifier(current.barrier_id) ||
      !validStoredIdentifier(current.runtime_execution_id)
    ) {
      throw new Error("Stored Runtime barrier identity is invalid");
    }
    return {
      runtimeRevision,
      barrier: current.has_nonterminal
        ? null
        : {
            barrierId: current.barrier_id,
            runtimeExecutionId: current.runtime_execution_id,
          },
    };
  }
}

function validStoredIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^\S{1,200}$/u.test(value);
}
