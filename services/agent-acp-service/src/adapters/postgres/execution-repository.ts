import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { budgetFactSchema } from "../../domain/model-budget.js";
import { ownershipScope, type AgentOwnershipScope } from "../../domain/agent-ownership.js";
import type {
  RunOutcome,
  RunState,
  RunStopReason,
  UnknownEffectSource,
} from "../../domain/types.js";
import type {
  ExecutionRepository,
  FinishLocalRunInput,
  RecoveryWork,
  RunRecoveryReader,
  RunRecoveryState,
  RuntimeProtectionRepository,
  RuntimeProtectionScope,
} from "../../ports/execution-repository.js";
import type { PostgresKernel } from "./kernel.js";
import { createRuntimeBarrierForRun } from "./runtime-barrier.js";
import { RunWriteAuthority, type RunOwnerColumns } from "./run-write-authority.js";

export class PostgresExecutionRepository
  implements ExecutionRepository, RunRecoveryReader, RuntimeProtectionRepository
{
  readonly #authority: RunWriteAuthority;

  public constructor(
    private readonly kernel: PostgresKernel,
    authority: RunWriteAuthority,
  ) {
    if (!(authority instanceof RunWriteAuthority))
      throw new TypeError("Execution writers require explicit authority");
    this.#authority = authority;
  }

  public async hasUnstoppedRuntimeCalls(
    scope: RuntimeProtectionScope,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.kernel.read<{ protected: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM tool_attempts AS attempt
         JOIN runs AS run ON run.id = attempt.run_id
         JOIN acp_sessions AS session ON session.id = run.session_id
         WHERE session.organization_id = $1 AND session.agent_id = $2
           AND ($3::text IS NULL OR run.execution_snapshot->'runtime'->>'revision' = $3)
           AND attempt.source = 'runtime' AND NOT attempt.runtime_call_stopped
       ) OR EXISTS (
         SELECT 1 FROM temporary_skill_scopes temporary JOIN runs run ON run.id=temporary.run_id
         WHERE temporary.organization_id=$1 AND temporary.agent_id=$2 AND temporary.released_at IS NULL
           AND ($3::text IS NULL OR run.execution_snapshot->'runtime'->>'revision'=$3)
       ) OR EXISTS (
         SELECT 1 FROM learning_runtime_protections protection
         WHERE protection.organization_id=$1 AND protection.agent_id=$2 AND protection.retired_at IS NULL
           AND ($3::text IS NULL OR protection.runtime_revision=$3)
       ) AS protected`,
      [scope.organizationId, scope.agentId, scope.runtimeRevision],
      signal,
    );
    return result.rows[0]!.protected;
  }

  public async getState(runId: string): Promise<RunState | null> {
    const result = await this.kernel.query<{ state: RunState }>(
      "SELECT state FROM runs WHERE id = $1",
      [runId],
    );
    return result.rows[0]?.state ?? null;
  }

  public async getRecoveryState(runId: string): Promise<RunRecoveryState | null> {
    const result = await this.kernel.query<TerminalOutcomeRow & { state: RunState }>(
      `SELECT state, terminal_class, executor_state, tool_effect_state,
              unknown_effect_source, stop_reason, error_class, budget_reason
         FROM runs WHERE id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.state === "admitting" || row.state === "running") return { kind: row.state };
    const outcome = storedOutcome(row);
    if (row.state !== outcome.terminalClass) throw new Error("Run has inconsistent terminal state");
    return { kind: "terminal", outcome };
  }

  public async finish(request: FinishLocalRunInput): Promise<void> {
    const input = structuredClone(request);
    // This read chooses the organization lock only. Recheck all identity facts
    // on the original transaction connection after organization and lease locks.
    const scope = await this.kernel.query<{ organization_id: string; session_id: string }>(
      `SELECT session.organization_id, run.session_id FROM runs run
       JOIN acp_sessions session ON session.id=run.session_id WHERE run.id=$1`,
      [input.runId],
    );
    const original = scope.rows[0];
    if (!original) throw new Error("Run cannot enter the requested terminal state");
    await this.#authority.organizationTransaction(
      this.kernel,
      original.organization_id,
      async (client) => {
        const session = await client.query<{ organization_id: string; agent_id: string }>(
          "SELECT organization_id, agent_id FROM acp_sessions WHERE id=$1 FOR UPDATE",
          [original.session_id],
        );
        const sessionRow = session.rows[0];
        if (!sessionRow || sessionRow.organization_id !== original.organization_id)
          throw new Error("Run changed Session identity");
        this.#authority.assertSession(sessionRow);
        const locked = await client.query<RunOwnerColumns & { session_id: string }>(
          `SELECT session_id, organization_id, agent_id, execution_owner_registration_id,
          execution_owner_member_id, execution_owner_incarnation_id, execution_owner_epoch::text
         FROM runs WHERE id=$1 FOR UPDATE`,
          [input.runId],
        );
        const runRow = locked.rows[0];
        if (
          !runRow ||
          runRow.session_id !== original.session_id ||
          runRow.organization_id !== sessionRow.organization_id ||
          runRow.agent_id !== sessionRow.agent_id
        )
          throw new Error("Run changed Session identity");
        this.#authority.assertRun(runRow);
        await finishLockedRun(client, input);
      },
    );
  }

  public async listRecoveryWork(scope?: AgentOwnershipScope): Promise<RecoveryWork[]> {
    const fixed = scope === undefined ? undefined : ownershipScope(scope);
    this.#authority.assertLegacyRecovery(fixed);
    return this.#authority.transaction(this.kernel, async (client) => {
      const result = await client.query<RecoveryWork & RunOwnerColumns>(
        `SELECT id, state AS kind, organization_id, agent_id, execution_owner_registration_id,
              execution_owner_member_id, execution_owner_incarnation_id, execution_owner_epoch::text
         FROM runs
        WHERE state IN ('admitting', 'running')
          AND ($1::text IS NULL OR (organization_id=$1 AND agent_id=$2))
        ORDER BY created_at, id`,
        [fixed?.organizationId ?? null, fixed?.agentId ?? null],
      );
      // Do not partially recover a mixed database. Returning only legacy rows
      // could silently leave owned reservations to an unscoped startup worker.
      for (const row of result.rows) this.#authority.assertRun(row);
      return result.rows.map(({ id, kind }) => ({ id, kind }));
    });
  }
}

export async function finishLockedRun(
  client: PoolClient,
  input: FinishLocalRunInput,
): Promise<void> {
  const budget = input.budget === undefined ? undefined : budgetFactSchema.parse(input.budget);
  if (
    budget !== undefined &&
    (input.errorClass !== "budget_exceeded" ||
      !["failed", "unresolved"].includes(input.terminalClass))
  )
    throw new Error("Budget facts require a budget terminal outcome");
  const result = await client.query(
    `WITH finished AS (UPDATE runs
          SET state = $2, terminal_class = $2, executor_state = $3,
              tool_effect_state = $4, unknown_effect_source = $5,
              stop_reason = $6, error_class = $7, updated_at = $8, budget_reason = $9::jsonb
        WHERE id = $1 AND state = 'running' RETURNING id, session_id),
       refused_messages AS (
         UPDATE session_messages SET context_excluded = true
         FROM finished WHERE session_messages.session_id = finished.session_id
           AND session_messages.run_id = finished.id AND $6 = 'refusal'
         RETURNING session_messages.session_id, session_messages.sequence
       ),
       invalidated_checkpoints AS (
         DELETE FROM context_checkpoints USING refused_messages
         WHERE context_checkpoints.session_id = refused_messages.session_id
           AND context_checkpoints.through_sequence >= refused_messages.sequence
       ),
       cancelled_permissions AS (
         UPDATE tool_permissions SET decision = 'cancelled', reason = 'run_finished', decided_at = $8
         FROM finished WHERE tool_permissions.run_id = finished.id AND decision IS NULL
       ) SELECT id FROM finished`,
    [
      input.runId,
      input.terminalClass,
      input.executorState,
      input.toolEffectState,
      input.unknownEffectSource ?? null,
      input.stopReason ?? null,
      input.errorClass ?? null,
      input.finishedAt,
      budget === undefined ? null : JSON.stringify(budget),
    ],
  );
  if (result.rowCount === 1) {
    await createRuntimeBarrierForRun(client, input.runId);
    return;
  }
  const stored = await loadTerminalOutcome(client, input.runId);
  if (stored === null || !sameOutcome(stored, input)) {
    throw new Error("Run cannot enter the requested terminal state");
  }
}

async function loadTerminalOutcome(client: PoolClient, runId: string): Promise<RunOutcome | null> {
  const result = await client.query<TerminalOutcomeRow>(
    `SELECT terminal_class, executor_state, tool_effect_state,
              unknown_effect_source, stop_reason, error_class, budget_reason
         FROM runs
        WHERE id = $1`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined || row.terminal_class === null) {
    return null;
  }
  return storedOutcome(row);
}

type TerminalOutcomeRow = {
  terminal_class: "completed" | "cancelled" | "failed" | "unresolved" | null;
  executor_state: "quiescent" | "cancellation_requested" | "unknown" | null;
  tool_effect_state: "none" | "settled" | "unknown" | null;
  unknown_effect_source: UnknownEffectSource | null;
  stop_reason: RunStopReason | null;
  error_class: string | null;
  budget_reason: unknown;
};

function storedOutcome(row: TerminalOutcomeRow): RunOutcome {
  const budget = row.budget_reason === null ? undefined : budgetFactSchema.parse(row.budget_reason);
  if (
    budget !== undefined &&
    (row.error_class !== "budget_exceeded" ||
      (row.terminal_class !== "failed" && row.terminal_class !== "unresolved"))
  )
    throw new Error("Run has inconsistent budget terminal facts");
  switch (row.terminal_class) {
    case "completed":
      if (
        row.executor_state !== "quiescent" ||
        row.tool_effect_state === null ||
        row.tool_effect_state === "unknown" ||
        row.stop_reason === null ||
        row.unknown_effect_source !== null
      ) {
        throw new Error("Completed Run has invalid terminal facts");
      }
      return {
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: row.tool_effect_state,
        stopReason: row.stop_reason,
      };
    case "cancelled":
      if (
        row.executor_state !== "quiescent" ||
        row.tool_effect_state === null ||
        row.tool_effect_state === "unknown" ||
        row.stop_reason !== null ||
        row.error_class !== null ||
        row.unknown_effect_source !== null
      ) {
        throw new Error("Cancelled Run has invalid terminal facts");
      }
      return {
        terminalClass: "cancelled",
        executorState: "quiescent",
        toolEffectState: row.tool_effect_state,
      };
    case "failed":
      if (
        row.executor_state !== "quiescent" ||
        row.tool_effect_state === null ||
        row.tool_effect_state === "unknown" ||
        row.error_class === null ||
        row.stop_reason !== null ||
        row.unknown_effect_source !== null
      ) {
        throw new Error("Failed Run has invalid terminal facts");
      }
      return {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: row.tool_effect_state,
        errorClass: row.error_class,
        ...(budget === undefined ? {} : { budget }),
      };
    case "unresolved":
      if (
        row.executor_state !== "quiescent" ||
        row.tool_effect_state !== "unknown" ||
        row.error_class === null ||
        row.stop_reason !== null ||
        !isUnknownEffectSource(row.unknown_effect_source)
      ) {
        throw new Error("Unresolved Run has invalid terminal facts");
      }
      return {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        unknownEffectSource: row.unknown_effect_source,
        errorClass: row.error_class,
        ...(budget === undefined ? {} : { budget }),
      };
    case null:
      throw new Error("Terminal Run has no terminal class");
  }
}

function sameOutcome(left: RunOutcome, right: RunOutcome): boolean {
  return (
    left.terminalClass === right.terminalClass &&
    left.toolEffectState === right.toolEffectState &&
    (left.unknownEffectSource ?? null) === (right.unknownEffectSource ?? null) &&
    (left.stopReason ?? null) === (right.stopReason ?? null) &&
    (left.errorClass ?? null) === (right.errorClass ?? null) &&
    isDeepStrictEqual(left.budget, right.budget)
  );
}

function isUnknownEffectSource(value: unknown): value is UnknownEffectSource {
  return value === "runtime_mcp" || value === "client_mcp" || value === "unclassified";
}
