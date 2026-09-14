import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { projectUsage } from "../../domain/usage.js";

import type { ToolEffectState, UnknownEffectSource } from "../../domain/types.js";
import type { InterruptedToolEffects } from "../../ports/run-event-repository.js";

import type { SessionEvent } from "../../ports/acp-application.js";
import type {
  AppendAgentMessageInput,
  AppendToolProgressInput,
  AppendRejectedToolCallInput,
  FinishToolAttemptInput,
  RunEventRepository,
  StartToolAttemptInput,
} from "../../ports/run-event-repository.js";
import type { PostgresKernel } from "./kernel.js";
import {
  decodeSessionEvent,
  encodeSessionEvent,
  type StoredSessionEvent,
} from "./session-event-codec.js";

export class PostgresRunEventRepository implements RunEventRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public appendPlan(input: Parameters<RunEventRepository["appendPlan"]>[0]): Promise<boolean> {
    return this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, input.runId);
      const run = await client.query<{ cancel_requested_at: Date | null }>(
        "SELECT cancel_requested_at FROM runs WHERE id = $1",
        [input.runId],
      );
      if (requireRow(run.rows[0], "Run does not exist").cancel_requested_at !== null) return false;
      for (const [index, event] of input.events.entries()) {
        await appendLocked(
          client,
          { ...locked, nextSequence: locked.nextSequence + index },
          `${input.id}:${index}`,
          event.kind,
          event,
          input.createdAt,
        );
      }
      return true;
    });
  }

  public async appendToolProgress(input: AppendToolProgressInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "tool_call",
      initial: false,
      toolCallId: input.toolCallId,
      status: "in_progress",
      content: input.content,
    };
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, input.runId);
      const attempt = await client.query(
        "SELECT id FROM tool_attempts WHERE run_id = $1 AND tool_call_id = $2 AND state = 'in_progress'",
        [input.runId, input.toolCallId],
      );
      if (attempt.rowCount !== 1) throw new Error("Tool attempt is not in progress");
      await appendLocked(client, locked, input.id, "tool_call", event, input.createdAt);
    });
    return event;
  }

  public async appendAgentMessage(input: AppendAgentMessageInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "agent_message",
      messageId: input.id,
      content: input.content,
      ...(input.toolCalls === undefined ? {} : { toolCalls: input.toolCalls }),
      ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
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
      ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
      content: input.content,
    };
    await this.append(input.runId, input.id, "agent_thought", event, input.createdAt);
    return event;
  }

  public appendUsage(
    input: Parameters<RunEventRepository["appendUsage"]>[0],
  ): Promise<SessionEvent> {
    return this.kernel.transaction(async (client) => {
      const existing = await storedUsage(client, input);
      if (existing !== undefined) return existing;
      const locked = await lockSessionRun(client, input.runId);
      const concurrent = await storedUsage(client, input);
      if (concurrent !== undefined) return concurrent;
      requireRunning(locked.state);
      const previous = await client.query<{ payload: StoredSessionEvent }>(
        "SELECT payload FROM session_messages WHERE session_id = $1 AND kind = 'usage' ORDER BY sequence DESC LIMIT 1",
        [locked.sessionId],
      );
      const stored = previous.rows[0]?.payload;
      const prior = stored === undefined ? undefined : decodeSessionEvent(stored);
      const event: SessionEvent = {
        kind: "usage",
        ...projectUsage(
          input.usage,
          input.contextSize,
          prior?.kind === "usage" ? prior.cost : undefined,
        ),
      };
      await appendLocked(client, locked, input.id, "usage", event, input.createdAt);
      return event;
    });
  }

  public async startToolAttempt(input: StartToolAttemptInput): Promise<SessionEvent> {
    const event: SessionEvent = {
      kind: "tool_call",
      initial: true,
      toolCallId: input.toolCallId,
      title: input.tool.name,
      ...input.presentation,
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
      ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
      ...(input.file === undefined ? {} : { file: input.file }),
    };
    await this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, input.runId);
      const updated = await client.query(
        `UPDATE tool_attempts
            SET state = $3, result_summary = $4::jsonb, tool_effect_state = $5,
                finished_at = $6, updated_at = $6, runtime_call_stopped = $7
          WHERE run_id = $1 AND tool_call_id = $2 AND state = 'in_progress'`,
        [
          input.runId,
          input.toolCallId,
          input.status,
          JSON.stringify(input.resultSummary),
          input.toolEffectState,
          input.createdAt,
          input.runtimeCallStopped === true,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error("Tool attempt is not in progress");
      }
      await appendLocked(client, locked, input.id, "tool_call", event, input.createdAt);
    });
    return event;
  }

  public async interruptToolAttempts(
    runId: string,
    interruptedAt: Date,
  ): Promise<InterruptedToolEffects> {
    return this.kernel.transaction(async (client) => {
      const locked = await lockRunAndSession(client, runId);
      const attempts = await client.query<{
        id: string;
        tool_call_id: string;
        source: "runtime" | "client";
        state: string;
        tool_effect_state: ToolEffectState;
      }>(
        `SELECT id, tool_call_id, source, state, tool_effect_state
           FROM tool_attempts
          WHERE run_id = $1
          ORDER BY created_at, id
          FOR UPDATE`,
        [runId],
      );
      let effectState: ToolEffectState = "none";
      let unknownEffectSource: UnknownEffectSource | undefined;
      let interrupted = 0;
      for (const attempt of attempts.rows) {
        effectState = combineEffects(effectState, attempt.tool_effect_state);
        const attemptEffectSource = attempt.source === "runtime" ? "runtime_mcp" : "client_mcp";
        if (attempt.tool_effect_state === "unknown") {
          unknownEffectSource = mergeUnknownEffectSource(unknownEffectSource, attemptEffectSource);
        }
        if (attempt.state !== "in_progress") {
          continue;
        }
        effectState = "unknown";
        unknownEffectSource = mergeUnknownEffectSource(unknownEffectSource, attemptEffectSource);
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
            status: "failed",
            content,
          },
          interruptedAt,
        );
        interrupted += 1;
      }
      await appendUnstartedToolResults(client, locked, runId, interruptedAt, interrupted);
      if (effectState === "unknown") {
        return {
          toolEffectState: "unknown",
          unknownEffectSource: unknownEffectSource ?? "unclassified",
        };
      }
      return { toolEffectState: effectState };
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

function mergeUnknownEffectSource(
  current: UnknownEffectSource | undefined,
  next: UnknownEffectSource,
): UnknownEffectSource {
  if (current === undefined || current === next) {
    return next;
  }
  return "unclassified";
}

type LockedRun = { runId: string; sessionId: string; nextSequence: number };

async function storedUsage(
  client: PoolClient,
  input: Parameters<RunEventRepository["appendUsage"]>[0],
): Promise<SessionEvent | undefined> {
  const result = await client.query<{ run_id: string; payload: StoredSessionEvent }>(
    "SELECT run_id, payload FROM session_messages WHERE id = $1",
    [input.id],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const event = decodeSessionEvent(row.payload);
  if (
    row.run_id !== input.runId ||
    event.kind !== "usage" ||
    event.size !== input.contextSize ||
    !isDeepStrictEqual(event.measurement, input.usage)
  )
    throw new Error("Usage receipt identity conflict");
  return event;
}

async function lockRunAndSession(client: PoolClient, runId: string): Promise<LockedRun> {
  const locked = await lockSessionRun(client, runId);
  requireRunning(locked.state);
  return locked;
}

function requireRunning(state: string): void {
  if (state !== "running") throw new Error("Run is not running");
}

async function lockSessionRun(
  client: PoolClient,
  runId: string,
): Promise<LockedRun & { state: string }> {
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
  return {
    runId,
    sessionId,
    state: runRow.state,
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
      JSON.stringify(encodeSessionEvent(event)),
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
        AND (COALESCE(payload ->> 'toolCallsJson', '[]') <> '[]'
          OR (jsonb_typeof(payload -> 'toolCalls') = 'array' AND jsonb_array_length(payload -> 'toolCalls') > 0))
      ORDER BY sequence DESC
      LIMIT 1`,
    [runId],
  );
  const row = assistant.rows[0];
  if (row === undefined) {
    return;
  }
  const calls = recoveryToolCalls(decodeSessionEvent(row.payload as StoredSessionEvent));
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
