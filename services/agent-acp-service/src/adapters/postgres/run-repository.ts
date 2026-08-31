import type { PoolClient } from "pg";

import type { EnvironmentChangeFact, SessionRecord } from "../../domain/types.js";
import { DomainError } from "../../domain/errors.js";
import type {
  AcceptRunInput,
  CreateRunIntentInput,
  RunIntent,
  RunRepository,
} from "../../ports/run-repository.js";
import type { PostgresKernel } from "./kernel.js";

export class PostgresRunRepository implements RunRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async getSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.kernel.query<{
      id: string;
      principal_id: string;
      agent_id: string;
      cwd: "/workspace";
      state: SessionRecord["state"];
      client_mcp_revision_id: string;
      last_execution_revision: string | null;
      last_message_sequence: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, principal_id, agent_id, cwd, state, client_mcp_revision_id,
              last_execution_revision, last_message_sequence, created_at, updated_at
         FROM acp_sessions WHERE id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          principalId: row.principal_id,
          agentId: row.agent_id,
          cwd: row.cwd,
          state: row.state,
          clientMcpRevisionId: row.client_mcp_revision_id,
          lastExecutionRevision: row.last_execution_revision,
          lastMessageSequence: Number(row.last_message_sequence),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
  }

  public async createRunIntent(input: CreateRunIntentInput): Promise<RunIntent> {
    try {
      return await this.kernel.transaction(async (client) => {
        const session = await client.query<{
          state: string;
          client_mcp_revision_id: string;
        }>(
          `SELECT state, client_mcp_revision_id
             FROM acp_sessions WHERE id = $1 FOR UPDATE`,
          [input.sessionId],
        );
        const sessionRow = requireRow(session.rows[0], "Session does not exist");
        if (sessionRow.state !== "active") {
          throw new DomainError("session_not_active", "Session is not active");
        }
        const result = await client.query<{
          id: string;
          request_id: string;
          session_id: string;
          client_mcp_revision_id: string;
          state: RunIntent["state"];
          pending_user_message_id: string;
          pending_prompt: unknown;
        }>(
          `INSERT INTO runs(
             id, request_id, session_id, client_mcp_revision_id, state,
             pending_user_message_id, pending_prompt,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'admitting', $5, $6::jsonb, $7, $7)
           RETURNING id, request_id, session_id, client_mcp_revision_id, state,
                     pending_user_message_id, pending_prompt`,
          [
            input.runId,
            input.requestId,
            input.sessionId,
            sessionRow.client_mcp_revision_id,
            input.userMessageId,
            JSON.stringify(input.prompt),
            input.createdAt,
          ],
        );
        const row = requireRow(result.rows[0], "Run intent was not created");
        return {
          id: row.id,
          requestId: row.request_id,
          sessionId: row.session_id,
          clientMcpRevisionId: row.client_mcp_revision_id,
          state: row.state,
          userMessageId: row.pending_user_message_id,
          prompt: row.pending_prompt as RunIntent["prompt"],
        };
      });
    } catch (error) {
      if (isConstraint(error, "runs_session_nonterminal_unique")) {
        throw new DomainError("session_busy", "Session already has a non-terminal Run");
      }
      throw error;
    }
  }

  public async requestCancellation(runId: string, requestedAt: Date): Promise<void> {
    await this.kernel.query(
      `UPDATE runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, $2), updated_at = $2
        WHERE id = $1 AND state IN ('admitting', 'running')`,
      [runId, requestedAt],
    );
  }

  public async acceptRun(input: AcceptRunInput): Promise<"accepted" | "cancelled"> {
    return this.kernel.transaction(async (client) => {
      const identity = await client.query<{ session_id: string }>(
        "SELECT session_id FROM runs WHERE id = $1",
        [input.runId],
      );
      const sessionId = requireRow(identity.rows[0], "Run intent does not exist").session_id;
      const session = await client.query<{ state: string; last_message_sequence: string }>(
        "SELECT state, last_message_sequence FROM acp_sessions WHERE id = $1 FOR UPDATE",
        [sessionId],
      );
      const sessionRow = requireRow(session.rows[0], "Session does not exist");
      const run = await client.query<{
        session_id: string;
        client_mcp_revision_id: string;
        state: string;
        cancel_requested_at: Date | null;
        pending_user_message_id: string | null;
        pending_prompt: unknown;
      }>(
        `SELECT session_id, client_mcp_revision_id, state,
                cancel_requested_at, pending_user_message_id, pending_prompt
           FROM runs WHERE id = $1 FOR UPDATE`,
        [input.runId],
      );
      const runRow = requireRow(run.rows[0], "Run intent does not exist");
      if (runRow.session_id !== sessionId) {
        throw new Error("Run intent changed Session identity");
      }
      if (runRow.state !== "admitting") {
        throw new Error("Run intent is no longer admitting");
      }
      if (runRow.pending_user_message_id === null || !Array.isArray(runRow.pending_prompt)) {
        throw new Error("Run intent has no recoverable prompt");
      }
      if (runRow.client_mcp_revision_id !== input.snapshot.clientMcpRevisionId) {
        throw new Error("Run snapshot does not match its captured client MCP revision");
      }
      if (runRow.cancel_requested_at !== null || sessionRow.state !== "active") {
        await client.query(
          `UPDATE runs
              SET state = 'cancelled', admission_id = $2, execution_snapshot = $3::jsonb,
                  pending_user_message_id = NULL, pending_prompt = NULL,
                  terminal_class = 'cancelled', executor_state = 'quiescent',
                  runtime_effect_state = 'none', error_class = 'run_cancelled',
                  cancel_requested_at = COALESCE(cancel_requested_at, $4), updated_at = $4
            WHERE id = $1`,
          [
            input.runId,
            input.snapshot.admissionId,
            JSON.stringify(input.snapshot),
            input.acceptedAt,
          ],
        );
        return "cancelled";
      }

      let sequence = Number(sessionRow.last_message_sequence);
      if (input.environmentFact !== null) {
        sequence += 1;
        await insertEnvironmentFact(client, input, input.environmentFact, sequence);
      }
      sequence += 1;
      await client.query(
        `INSERT INTO session_messages(
           id, session_id, run_id, sequence, kind, visible, payload, created_at
         ) VALUES ($1, $2, $3, $4, 'user_message', true, $5::jsonb, $6)`,
        [
          runRow.pending_user_message_id,
          runRow.session_id,
          input.runId,
          sequence,
          JSON.stringify({
            kind: "user_message",
            messageId: runRow.pending_user_message_id,
            content: runRow.pending_prompt,
          }),
          input.acceptedAt,
        ],
      );
      await client.query(
        `UPDATE runs
            SET state = 'running', admission_id = $2, execution_snapshot = $3::jsonb,
                pending_user_message_id = NULL, pending_prompt = NULL, updated_at = $4
          WHERE id = $1`,
        [input.runId, input.snapshot.admissionId, JSON.stringify(input.snapshot), input.acceptedAt],
      );
      await client.query(
        `UPDATE acp_sessions
            SET last_execution_revision = $2, last_message_sequence = $3, updated_at = $4
          WHERE id = $1`,
        [runRow.session_id, input.snapshot.executionRevision, sequence, input.acceptedAt],
      );
      return "accepted";
    });
  }

  public async rejectRun(
    runId: string,
    errorClass: string,
    rejectedAt: Date,
  ): Promise<"failed" | "cancelled"> {
    const result = await this.kernel.query<{ state: "failed" | "cancelled" }>(
      `UPDATE runs
          SET state = CASE WHEN cancel_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
              pending_user_message_id = NULL, pending_prompt = NULL,
              terminal_class = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'cancelled' END,
              executor_state = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'quiescent' END,
              runtime_effect_state = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'none' END,
              error_class = CASE WHEN cancel_requested_at IS NULL THEN $2 ELSE 'run_cancelled' END,
              updated_at = $3
        WHERE id = $1 AND state = 'admitting'
        RETURNING state`,
      [runId, errorClass, rejectedAt],
    );
    if (result.rowCount !== 1) {
      throw new Error("Run intent is no longer admitting");
    }
    return requireRow(result.rows[0], "Run rejection did not return state").state;
  }
}

async function insertEnvironmentFact(
  client: PoolClient,
  input: AcceptRunInput,
  fact: EnvironmentChangeFact,
  sequence: number,
): Promise<void> {
  await client.query(
    `INSERT INTO session_messages(
       id, session_id, run_id, sequence, kind, visible, payload, created_at
     )
     SELECT $1, session_id, id, $2, 'environment_change', false, $3::jsonb, $4
       FROM runs WHERE id = $5`,
    [
      `${input.runId}:environment-change`,
      sequence,
      JSON.stringify(fact),
      input.acceptedAt,
      input.runId,
    ],
  );
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message);
  }
  return row;
}

function isConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}
