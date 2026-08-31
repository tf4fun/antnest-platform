import type { PoolClient } from "pg";

import type { SessionEvent } from "../../ports/acp-application.js";
import type {
  AppendAgentMessageInput,
  FinishToolAttemptInput,
  RunEventRepository,
  StartToolAttemptInput,
} from "../../ports/run-event-repository.js";
import type { PostgresKernel } from "./kernel.js";

export class PostgresRunEventRepository implements RunEventRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async appendAgentMessage(input: AppendAgentMessageInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "agent_message",
      messageId: input.id,
      content: input.content,
    };
    await this.append(input.runId, input.id, "agent_message", event, input.createdAt);
    return event;
  }

  public async appendUsage(input: {
    id: string;
    runId: string;
    usage: { inputTokens: number; outputTokens: number };
    contextSize: number;
    createdAt: Date;
  }): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "usage",
      used: input.usage.inputTokens + input.usage.outputTokens,
      size: input.contextSize,
    };
    await this.append(input.runId, input.id, "usage", event, input.createdAt);
    return event;
  }

  public async startToolAttempt(input: StartToolAttemptInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "tool_call",
      toolCallId: input.toolCallId,
      title: input.tool.name,
      status: "in_progress",
    };
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, input.runId);
      await client.query(
        `INSERT INTO tool_attempts(
           id, run_id, tool_call_id, source, source_id, tool_name, request_digest,
           state, runtime_effect_state, started_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', 'none', $8, $8, $8)`,
        [
          input.id,
          input.runId,
          input.toolCallId,
          input.tool.source,
          input.tool.sourceId,
          input.tool.name,
          input.requestDigest,
          input.createdAt,
        ],
      );
      await appendLocked(client, locked, input.id, "tool_call", event, input.createdAt);
    });
    return event;
  }

  public async finishToolAttempt(input: FinishToolAttemptInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "tool_call",
      toolCallId: input.toolCallId,
      status: input.status,
      content: input.content,
    };
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, input.runId);
      const updated = await client.query(
        `UPDATE tool_attempts
            SET state = $3, result_summary = $4::jsonb, runtime_effect_state = $5,
                finished_at = $6, updated_at = $6
          WHERE run_id = $1 AND tool_call_id = $2 AND state = 'in_progress'`,
        [
          input.runId,
          input.toolCallId,
          input.status,
          JSON.stringify(input.resultSummary),
          input.runtimeEffectState,
          input.createdAt,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error("Tool attempt is not in progress");
      }
      await appendLocked(client, locked, input.id, "tool_call", event, input.createdAt);
    });
    return event;
  }

  public async interruptToolAttempts(runId: string, interruptedAt: Date): Promise<void> {
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, runId);
      const attempts = await client.query<{ id: string; tool_call_id: string; tool_name: string }>(
        `SELECT id, tool_call_id, tool_name
           FROM tool_attempts
          WHERE run_id = $1 AND state = 'in_progress'
          ORDER BY created_at, id
          FOR UPDATE`,
        [runId],
      );
      for (const [index, attempt] of attempts.rows.entries()) {
        const content = [
          {
            type: "text" as const,
            text: "Tool outcome is unknown because Agent ACP Service restarted.",
          },
        ];
        await client.query(
          `UPDATE tool_attempts
              SET state = 'failed', result_summary = $2::jsonb,
                  runtime_effect_state = 'unknown', finished_at = $3, updated_at = $3
            WHERE id = $1`,
          [attempt.id, JSON.stringify(content), interruptedAt],
        );
        await appendLocked(
          client,
          { ...locked, nextSequence: locked.nextSequence + index },
          `${attempt.id}:interrupted`,
          "tool_call",
          {
            kind: "tool_call",
            toolCallId: attempt.tool_call_id,
            title: attempt.tool_name,
            status: "failed",
            content,
          },
          interruptedAt,
        );
      }
    });
  }

  private async append(
    runId: string,
    id: string,
    kind: string,
    event: SessionEvent,
    createdAt: Date,
  ): Promise<void> {
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, runId);
      await appendLocked(client, locked, id, kind, event, createdAt);
    });
  }
}

type LockedRun = { runId: string; sessionId: string; nextSequence: number };

async function lockRunAndSession(client: PoolClient, runId: string): Promise<LockedRun> {
  const identity = await client.query<{ session_id: string }>(
    "SELECT session_id FROM runs WHERE id = $1",
    [runId],
  );
  const sessionId = requireRow(identity.rows[0], "Run does not exist").session_id;
  const session = await client.query<{ last_message_sequence: string }>(
    "SELECT last_message_sequence FROM acp_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  const sessionRow = requireRow(session.rows[0], "Session does not exist");
  const run = await client.query<{ session_id: string; state: string }>(
    "SELECT session_id, state FROM runs WHERE id = $1 FOR UPDATE",
    [runId],
  );
  const runRow = requireRow(run.rows[0], "Run does not exist");
  if (runRow.session_id !== sessionId) {
    throw new Error("Run changed Session identity");
  }
  if (runRow.state !== "running") {
    throw new Error("Run is not running");
  }
  return {
    runId,
    sessionId,
    nextSequence: Number(sessionRow.last_message_sequence) + 1,
  };
}

async function appendLocked(
  client: PoolClient,
  locked: LockedRun,
  id: string,
  kind: string,
  event: SessionEvent,
  createdAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO session_messages(
       id, session_id, run_id, sequence, kind, visible, payload, created_at
     ) VALUES ($1, $2, $3, $4, $5, true, $6::jsonb, $7)`,
    [
      id,
      locked.sessionId,
      locked.runId,
      locked.nextSequence,
      kind,
      JSON.stringify(event),
      createdAt,
    ],
  );
  await client.query(
    "UPDATE acp_sessions SET last_message_sequence = $2, updated_at = $3 WHERE id = $1",
    [locked.sessionId, locked.nextSequence, createdAt],
  );
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message);
  }
  return row;
}
