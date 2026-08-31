import type { PoolClient } from "pg";

import type { ToolEffectState } from "../../domain/types.js";

import type { SessionEvent } from "../../ports/acp-application.js";
import type {
  AppendAgentMessageInput,
  AppendRejectedToolCallInput,
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
      ...(input.toolCalls === undefined ? {} : { toolCalls: input.toolCalls }),
    };
    await this.append(
      input.runId,
      input.id,
      "agent_message",
      event,
      input.createdAt,
      input.content.length > 0,
    );
    return event;
  }

  public async appendAgentThought(input: AppendAgentMessageInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "agent_thought",
      messageId: input.id,
      content: input.content,
    };
    await this.append(input.runId, input.id, "agent_thought", event, input.createdAt);
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
      initial: true,
      toolCallId: input.toolCallId,
      title: input.tool.name,
      modelName: input.tool.modelName,
      arguments: input.arguments,
      status: "in_progress",
    };
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, input.runId);
      await client.query(
        `INSERT INTO tool_attempts(
           id, run_id, tool_call_id, source, source_id, tool_name, request_digest,
           state, tool_effect_state, started_at, created_at, updated_at
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

  public async appendRejectedToolCall(input: AppendRejectedToolCallInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "tool_call",
      initial: true,
      toolCallId: input.call.id,
      title: input.call.name,
      modelName: input.call.name,
      arguments: input.call.arguments,
      status: "failed",
      content: [{ type: "text", text: input.message }],
    };
    await this.append(input.runId, input.id, "tool_call", event, input.createdAt);
    return event;
  }

  public async finishToolAttempt(input: FinishToolAttemptInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "tool_call",
      initial: false,
      toolCallId: input.toolCallId,
      status: input.status,
      content: input.content,
    };
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, input.runId);
      const updated = await client.query(
        `UPDATE tool_attempts
            SET state = $3, result_summary = $4::jsonb, tool_effect_state = $5,
                finished_at = $6, updated_at = $6
          WHERE run_id = $1 AND tool_call_id = $2 AND state = 'in_progress'`,
        [
          input.runId,
          input.toolCallId,
          input.status,
          JSON.stringify(input.resultSummary),
          input.toolEffectState,
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

  public async interruptToolAttempts(runId: string, interruptedAt: Date): Promise<ToolEffectState> {
    return this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, runId);
      const attempts = await client.query<{
        id: string;
        tool_call_id: string;
        tool_name: string;
        state: string;
        tool_effect_state: ToolEffectState;
      }>(
        `SELECT id, tool_call_id, tool_name, state, tool_effect_state
           FROM tool_attempts
          WHERE run_id = $1
          ORDER BY created_at, id
          FOR UPDATE`,
        [runId],
      );
      let effectState: ToolEffectState = "none";
      let interrupted = 0;
      for (const attempt of attempts.rows) {
        effectState = combineEffects(effectState, attempt.tool_effect_state);
        if (attempt.state !== "in_progress") {
          continue;
        }
        effectState = "unknown";
        const content = [
          {
            type: "text" as const,
            text: "Tool outcome is unknown because Agent ACP Service restarted.",
          },
        ];
        await client.query(
          `UPDATE tool_attempts
              SET state = 'failed', result_summary = $2::jsonb,
                  tool_effect_state = 'unknown', finished_at = $3, updated_at = $3
            WHERE id = $1`,
          [attempt.id, JSON.stringify(content), interruptedAt],
        );
        await appendLocked(
          client,
          { ...locked, nextSequence: locked.nextSequence + interrupted },
          `${attempt.id}:interrupted`,
          "tool_call",
          {
            kind: "tool_call",
            initial: false,
            toolCallId: attempt.tool_call_id,
            title: attempt.tool_name,
            status: "failed",
            content,
          },
          interruptedAt,
        );
        interrupted += 1;
      }
      await appendUnstartedToolResults(client, locked, runId, interruptedAt, interrupted);
      return effectState;
    });
  }

  private async append(
    runId: string,
    id: string,
    kind: string,
    event: SessionEvent,
    createdAt: Date,
    visible = true,
  ): Promise<void> {
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, runId);
      await appendLocked(client, locked, id, kind, event, createdAt, visible);
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
  visible = true,
): Promise<void> {
  await client.query(
    `INSERT INTO session_messages(
       id, session_id, run_id, sequence, kind, visible, payload, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      id,
      locked.sessionId,
      locked.runId,
      locked.nextSequence,
      kind,
      visible,
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

function combineEffects(current: ToolEffectState, next: ToolEffectState): ToolEffectState {
  if (current === "unknown" || next === "unknown") {
    return "unknown";
  }
  return current === "settled" || next === "settled" ? "settled" : "none";
}

async function appendUnstartedToolResults(
  client: PoolClient,
  locked: LockedRun,
  runId: string,
  interruptedAt: Date,
  sequenceOffset: number,
): Promise<void> {
  const assistant = await client.query<{ id: string; sequence: string; payload: unknown }>(
    `SELECT id, sequence, payload
       FROM session_messages
      WHERE run_id = $1
        AND kind = 'agent_message'
        AND jsonb_typeof(payload -> 'toolCalls') = 'array'
        AND jsonb_array_length(payload -> 'toolCalls') > 0
      ORDER BY sequence DESC
      LIMIT 1`,
    [runId],
  );
  const row = assistant.rows[0];
  if (row === undefined) {
    return;
  }
  const calls = recoveryToolCalls(row.payload);
  const events = await client.query<{ payload: unknown }>(
    `SELECT payload
       FROM session_messages
      WHERE run_id = $1 AND kind = 'tool_call' AND sequence > $2
      ORDER BY sequence`,
    [runId, row.sequence],
  );
  const terminal = new Set(
    events.rows
      .map((event) => terminalToolCallId(event.payload))
      .filter((toolCallId): toolCallId is string => toolCallId !== null),
  );
  let appended = 0;
  for (const call of calls) {
    if (terminal.has(call.id)) {
      continue;
    }
    const content = [
      {
        type: "text" as const,
        text: "Tool was not executed because Agent ACP Service restarted before dispatch.",
      },
    ];
    await appendLocked(
      client,
      { ...locked, nextSequence: locked.nextSequence + sequenceOffset + appended },
      `${row.id}:not-executed:${appended}`,
      "tool_call",
      {
        kind: "tool_call",
        initial: true,
        toolCallId: call.id,
        title: call.name,
        modelName: call.name,
        status: "failed",
        content,
      },
      interruptedAt,
    );
    appended += 1;
  }
}

function recoveryToolCalls(value: unknown): Array<{ id: string; name: string }> {
  const event = asRecord(value, "Assistant Tool response is invalid");
  if (!Array.isArray(event.toolCalls)) {
    throw new Error("Assistant Tool calls are invalid");
  }
  return event.toolCalls.map((value) => {
    const call = asRecord(value, "Assistant Tool call is invalid");
    if (typeof call.id !== "string" || typeof call.name !== "string") {
      throw new Error("Assistant Tool call identity is invalid");
    }
    return { id: call.id, name: call.name };
  });
}

function terminalToolCallId(value: unknown): string | null {
  const event = asRecord(value, "Tool event is invalid");
  if (
    typeof event.toolCallId !== "string" ||
    typeof event.status !== "string" ||
    event.status === "pending" ||
    event.status === "in_progress"
  ) {
    return null;
  }
  return event.toolCallId;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}
