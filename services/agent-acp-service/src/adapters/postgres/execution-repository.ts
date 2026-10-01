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
  RuntimeProtectionRepository,
  RuntimeProtectionScope,
} from "../../ports/execution-repository.js";
import type { PostgresKernel } from "./kernel.js";

export class PostgresExecutionRepository
  implements ExecutionRepository, RuntimeProtectionRepository
{
  public constructor(private readonly kernel: PostgresKernel) {}

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

  public async finish(input: FinishLocalRunInput): Promise<void> {
    const result = await this.kernel.query(
      `WITH finished AS (UPDATE runs
          SET state = $2, terminal_class = $2, executor_state = $3,
              tool_effect_state = $4, unknown_effect_source = $5,
              stop_reason = $6, error_class = $7, updated_at = $8
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
      ],
    );
    if (result.rowCount === 1) {
      return;
    }
    const stored = await this.loadTerminalOutcome(input.runId);
    if (stored === null || !sameOutcome(stored, input)) {
      throw new Error("Run cannot enter the requested terminal state");
    }
  }

  private async loadTerminalOutcome(runId: string): Promise<RunOutcome | null> {
    const result = await this.kernel.query<TerminalOutcomeRow>(
      `SELECT terminal_class, executor_state, tool_effect_state,
              unknown_effect_source, stop_reason, error_class
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

  public async listRecoveryWork(): Promise<RecoveryWork[]> {
    const result = await this.kernel.query<RecoveryWork>(
      `SELECT id, state AS kind
         FROM runs
        WHERE state IN ('admitting', 'running')
        ORDER BY created_at, id`,
    );
    return result.rows;
  }
}

type TerminalOutcomeRow = {
  terminal_class: "completed" | "cancelled" | "failed" | "unresolved" | null;
  executor_state: "quiescent" | "cancellation_requested" | "unknown" | null;
  tool_effect_state: "none" | "settled" | "unknown" | null;
  unknown_effect_source: UnknownEffectSource | null;
  stop_reason: RunStopReason | null;
  error_class: string | null;
};

function storedOutcome(row: TerminalOutcomeRow): RunOutcome {
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
    (left.errorClass ?? null) === (right.errorClass ?? null)
  );
}

function isUnknownEffectSource(value: unknown): value is UnknownEffectSource {
  return value === "runtime_mcp" || value === "client_mcp" || value === "unclassified";
}
