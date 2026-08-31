import { z } from "zod";

import type {
  RunExecutionSnapshot,
  RunOutcome,
  RunState,
  RunStopReason,
} from "../../domain/types.js";
import type {
  ExecutionRepository,
  FinishLocalRunInput,
  RecoveryWork,
} from "../../ports/execution-repository.js";
import type { PostgresKernel } from "./kernel.js";

const contentSchema = z.array(z.object({ type: z.string() }).catchall(z.unknown()));
const snapshotSchema = z.object({
  admissionId: z.string().min(1),
  admissionDeadline: z.coerce.date(),
  agentSpecRevision: z.string().min(1),
  executionRevision: z.string().min(1),
  runtimeMcpSourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  agentExecutionSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  credentialVersion: z.string().min(1),
  runtime: z.object({
    revision: z.string().min(1),
    executionId: z.string().min(1),
    mcpEndpoint: z.url(),
  }),
  executionSpec: z.object({
    systemPrompt: z.string(),
    contextPolicyVersion: z.literal("context-v1"),
    skillInstructions: z.array(
      z.object({ skillKey: z.string(), version: z.string(), instructions: z.string() }),
    ),
    model: z.object({
      baseUrl: z.url(),
      model: z.string().min(1),
      contextWindow: z.number().int().positive(),
      maxOutputTokens: z.number().int().positive(),
      temperature: z.number().optional(),
      supportsImages: z.boolean(),
    }),
    maxModelRequests: z.number().int().positive(),
    credentialRef: z.string().min(1),
  }),
  clientMcpRevisionId: z.string().min(1),
});

export class PostgresExecutionRepository implements ExecutionRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async getState(runId: string): Promise<RunState | null> {
    const result = await this.kernel.query<{ state: RunState }>(
      "SELECT state FROM runs WHERE id = $1",
      [runId],
    );
    return result.rows[0]?.state ?? null;
  }

  public async finish(input: FinishLocalRunInput): Promise<void> {
    const result = await this.kernel.query(
      `UPDATE runs
          SET state = $2, terminal_class = $2, executor_state = $3,
              tool_effect_state = $4, stop_reason = $5, error_class = $6, updated_at = $7
        WHERE id = $1 AND state = 'running'`,
      [
        input.runId,
        input.terminalClass,
        input.executorState,
        input.toolEffectState,
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
      `SELECT terminal_class, executor_state, tool_effect_state, stop_reason, error_class
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

  public async quarantine(runId: string, errorClass: string, finishedAt: Date): Promise<void> {
    const result = await this.kernel.query(
      `UPDATE runs
          SET state = 'unresolved', pending_user_message_id = NULL, pending_prompt = NULL,
              terminal_class = 'unresolved', executor_state = 'quiescent',
              tool_effect_state = 'unknown', error_class = $2, updated_at = $3
        WHERE id = $1 AND admission_finished_at IS NULL`,
      [runId, errorClass, finishedAt],
    );
    if (result.rowCount !== 1) {
      throw new Error("Recovery record cannot be quarantined");
    }
  }

  public async markAdmissionFinished(runId: string, finishedAt: Date): Promise<void> {
    const result = await this.kernel.query(
      `UPDATE runs SET admission_finished_at = COALESCE(admission_finished_at, $2)
        WHERE id = $1 AND state IN ('completed', 'cancelled', 'failed', 'unresolved')`,
      [runId, finishedAt],
    );
    if (result.rowCount !== 1) {
      throw new Error("Run is not terminal");
    }
  }

  public async listRecoveryWork(): Promise<RecoveryWork[]> {
    const result = await this.kernel.query<{
      id: string;
      request_id: string;
      session_id: string;
      client_mcp_revision_id: string;
      expected_access_revision: string;
      state: RunState;
      pending_user_message_id: string | null;
      pending_prompt: unknown;
      execution_snapshot: unknown;
      admission_id: string | null;
      terminal_class: "completed" | "cancelled" | "failed" | "unresolved" | null;
      executor_state: "quiescent" | "cancellation_requested" | "unknown" | null;
      tool_effect_state: "none" | "settled" | "unknown" | null;
      stop_reason: RunStopReason | null;
      error_class: string | null;
    }>(
      `SELECT id, request_id, session_id, client_mcp_revision_id,
              expected_access_revision, state,
              pending_user_message_id,
              pending_prompt, execution_snapshot, admission_id, terminal_class,
              executor_state, tool_effect_state, stop_reason, error_class
         FROM runs
        WHERE state IN ('admitting', 'running')
           OR (state IN ('completed', 'cancelled', 'failed', 'unresolved')
               AND admission_id IS NOT NULL AND admission_finished_at IS NULL)
        ORDER BY created_at, id`,
    );
    return result.rows.map(classifyRecoveryWork);
  }
}

function classifyRecoveryWork(row: Parameters<typeof mapRecoveryWork>[0]): RecoveryWork {
  try {
    return mapRecoveryWork(row);
  } catch {
    return {
      kind: "invalid",
      id: row.id,
      previousState: row.state,
      ...(row.admission_id === null ? {} : { admissionId: row.admission_id }),
      errorClass: "invalid_recovery_record",
    };
  }
}

function mapRecoveryWork(row: {
  id: string;
  request_id: string;
  session_id: string;
  client_mcp_revision_id: string;
  expected_access_revision: string;
  state: RunState;
  pending_user_message_id: string | null;
  pending_prompt: unknown;
  execution_snapshot: unknown;
  admission_id: string | null;
  terminal_class: "completed" | "cancelled" | "failed" | "unresolved" | null;
  executor_state: "quiescent" | "cancellation_requested" | "unknown" | null;
  tool_effect_state: "none" | "settled" | "unknown" | null;
  stop_reason: RunStopReason | null;
  error_class: string | null;
}): RecoveryWork {
  if (row.state === "admitting") {
    if (row.pending_user_message_id === null || row.pending_prompt === null) {
      throw new Error("Admitting Run has no durable prompt");
    }
    return {
      kind: "admitting",
      id: row.id,
      requestId: row.request_id,
      sessionId: row.session_id,
      clientMcpRevisionId: row.client_mcp_revision_id,
      expectedAccessRevision: row.expected_access_revision,
      userMessageId: row.pending_user_message_id,
      prompt: contentSchema.parse(row.pending_prompt),
    };
  }
  if (row.state === "running") {
    if (row.execution_snapshot === null) {
      throw new Error("Running Run has no execution snapshot");
    }
    return {
      kind: "running",
      id: row.id,
      requestId: row.request_id,
      sessionId: row.session_id,
      snapshot: snapshotSchema.parse(row.execution_snapshot) as RunExecutionSnapshot,
    };
  }
  if (
    row.admission_id === null ||
    row.terminal_class === null ||
    row.executor_state === null ||
    row.tool_effect_state === null
  ) {
    throw new Error("Terminal Run has incomplete admission facts");
  }
  const outcome = storedOutcome(row);
  return {
    kind: "finish_admission",
    id: row.id,
    admissionId: row.admission_id,
    ...outcome,
  };
}

type TerminalOutcomeRow = {
  terminal_class: "completed" | "cancelled" | "failed" | "unresolved" | null;
  executor_state: "quiescent" | "cancellation_requested" | "unknown" | null;
  tool_effect_state: "none" | "settled" | "unknown" | null;
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
        row.stop_reason === null
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
        row.stop_reason !== null
      ) {
        throw new Error("Cancelled Run has invalid terminal facts");
      }
      return {
        terminalClass: "cancelled",
        executorState: "quiescent",
        toolEffectState: row.tool_effect_state,
        ...(row.error_class === null ? {} : { errorClass: row.error_class }),
      };
    case "failed":
      if (
        row.executor_state !== "quiescent" ||
        row.tool_effect_state === null ||
        row.tool_effect_state === "unknown" ||
        row.error_class === null ||
        row.stop_reason !== null
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
        row.stop_reason !== null
      ) {
        throw new Error("Unresolved Run has invalid terminal facts");
      }
      return {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
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
    (left.stopReason ?? null) === (right.stopReason ?? null) &&
    (left.errorClass ?? null) === (right.errorClass ?? null)
  );
}
