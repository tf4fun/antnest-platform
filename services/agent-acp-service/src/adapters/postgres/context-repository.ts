import type { ContentBlock, RunExecutionSnapshot } from "../../domain/types.js";
import { decodeSessionEvent, type StoredSessionEvent } from "./session-event-codec.js";
import type {
  ContextCheckpoint,
  ContextRepository,
  ContextSource,
  SaveCheckpointInput,
  StoredContextMessage,
} from "../../ports/context-repository.js";
import type { PostgresKernel } from "./kernel.js";
import { RunWriteAuthority, type RunOwnerColumns } from "./run-write-authority.js";
import { AgentOwnershipLostError } from "../../domain/agent-ownership.js";

export class PostgresContextRepository implements ContextRepository {
  readonly #authority: RunWriteAuthority;
  public constructor(
    private readonly kernel: PostgresKernel,
    authority: RunWriteAuthority,
  ) {
    if (!(authority instanceof RunWriteAuthority))
      throw new TypeError("Context writers require explicit Run authority");
    this.#authority = authority;
  }

  public async loadCalibration(snapshot: RunExecutionSnapshot): Promise<number> {
    const result = await this.kernel.query<{ ratio_p95: number | string }>(
      "SELECT ratio_p95 FROM model_token_calibration WHERE organization_id=$1 AND model_profile_id=$2 AND model=$3 AND tokenizer=$4",
      [
        snapshot.organizationId,
        snapshot.modelProfileId,
        snapshot.executionSpec.model.model,
        snapshot.executionSpec.model.tokenizer ?? "none",
      ],
    );
    const ratio = Number(result.rows[0]?.ratio_p95);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  public async load(sessionId: string): Promise<ContextSource> {
    const checkpointResult = await this.kernel.query<{
      through_sequence: string;
      summary: string;
      compaction_prompt_version: string | null;
      pinned_message_ids: unknown;
    }>(
      `SELECT through_sequence, summary, compaction_prompt_version, pinned_message_ids
         FROM context_checkpoints
        WHERE session_id = $1
        ORDER BY through_sequence DESC
        LIMIT 1`,
      [sessionId],
    );
    const checkpoint = mapCheckpoint(checkpointResult.rows[0]);
    const pinnedResult = await this.kernel.query<{
      id: string;
      sequence: string;
      kind: string;
      payload: unknown;
    }>(
      `SELECT id,sequence,kind,payload FROM session_messages WHERE session_id=$1 AND NOT context_excluded AND kind='user_message' ORDER BY sequence LIMIT 1`,
      [sessionId],
    );
    const messagesResult = await this.kernel.query<{
      sequence: string;
      kind: string;
      payload: unknown;
    }>(
      `SELECT sequence, kind, payload
         FROM session_messages
        WHERE session_id = $1
          AND sequence > $2
          AND NOT context_excluded
          AND kind IN ('user_message', 'agent_message', 'agent_thought', 'environment_change', 'tool_call')
        ORDER BY sequence`,
      [sessionId, checkpoint?.throughSequence ?? 0],
    );
    const plan = await this.kernel.query<{ payload: StoredSessionEvent }>(
      "SELECT payload FROM session_messages WHERE session_id = $1 AND kind = 'plan' AND NOT context_excluded ORDER BY sequence DESC LIMIT 1",
      [sessionId],
    );
    const latestPlan =
      plan.rows[0] === undefined ? undefined : decodeSessionEvent(plan.rows[0].payload);
    const pinnedRow = pinnedResult.rows[0];
    const pinned: StoredContextMessage[] =
      pinnedRow === undefined
        ? []
        : [
            {
              id: pinnedRow.id,
              sequence: Number(pinnedRow.sequence),
              kind: "user_message",
              content: asContent(
                asRecord(pinnedRow.payload, "Session message payload is invalid").content,
              ),
            },
          ];
    return {
      checkpoint,
      pinned,
      messages: mapContextMessages(
        messagesResult.rows.map((row) => ({
          ...row,
          payload:
            row.kind === "agent_message"
              ? decodeSessionEvent(row.payload as StoredSessionEvent)
              : row.payload,
        })),
      ),
      ...(latestPlan?.kind === "plan" ? { plan: latestPlan.entries } : {}),
    };
  }

  public async saveCheckpoint(request: SaveCheckpointInput): Promise<void> {
    const input = structuredClone(request);
    await this.#authority.transaction(this.kernel, async (client) => {
      const session = await client.query<{ organization_id: string; agent_id: string }>(
        "SELECT organization_id,agent_id FROM acp_sessions WHERE id=$1 FOR UPDATE",
        [input.sessionId],
      );
      const sessionRow = session.rows[0];
      if (!sessionRow) throw new AgentOwnershipLostError();
      this.#authority.assertSession(sessionRow);
      const run = await client.query<RunOwnerColumns & { session_id: string; state: string }>(
        `SELECT session_id,state,organization_id,agent_id,execution_owner_registration_id,
          execution_owner_member_id,execution_owner_incarnation_id,execution_owner_epoch::text
         FROM runs WHERE id=$1 FOR UPDATE`,
        [input.runId],
      );
      const runRow = run.rows[0];
      if (
        !runRow ||
        runRow.session_id !== input.sessionId ||
        runRow.organization_id !== sessionRow.organization_id ||
        runRow.agent_id !== sessionRow.agent_id
      )
        throw new AgentOwnershipLostError();
      this.#authority.assertRun(runRow);
      if (runRow.state !== "running") throw new Error("Run is not running");
      await client.query(
        `INSERT INTO context_checkpoints(
         id, session_id, through_sequence, summary, token_count, created_at,
         compaction_prompt_version, pinned_message_ids
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_id, through_sequence) DO NOTHING`,
        [
          input.id,
          input.sessionId,
          input.throughSequence,
          input.summary,
          input.tokenCount,
          input.createdAt,
          input.compactionPromptVersion ?? null,
          JSON.stringify(input.pinnedMessageIds ?? []),
        ],
      );
    });
  }
}

function mapCheckpoint(
  row:
    | {
        through_sequence: string;
        summary: string;
        compaction_prompt_version: string | null;
        pinned_message_ids: unknown;
      }
    | undefined,
): ContextCheckpoint | null {
  if (row === undefined) {
    return null;
  }
  return {
    throughSequence: Number(row.through_sequence),
    summary: row.summary,
    ...(row.compaction_prompt_version === null
      ? {}
      : { compactionPromptVersion: row.compaction_prompt_version }),
    ...(Array.isArray(row.pinned_message_ids) &&
    row.pinned_message_ids.every((id) => typeof id === "string")
      ? { pinnedMessageIds: row.pinned_message_ids }
      : {}),
  };
}

function mapContextMessages(
  rows: Array<{ sequence: string; kind: string; payload: unknown }>,
): StoredContextMessage[] {
  const messages: StoredContextMessage[] = [];
  let pending: PendingToolExchange | null = null;
  for (const row of combineAssistantChunks(attachThoughts(rows))) {
    if (row.kind === "agent_message") {
      if (pending !== null) {
        throw new Error("Assistant Tool exchange is incomplete");
      }
      const message = mapAgentMessage(row);
      if (message.toolCalls.length === 0) {
        messages.push({
          sequence: message.sequence,
          ...(message.endSequence === undefined ? {} : { endSequence: message.endSequence }),
          kind: "agent_message",
          content: message.content,
          ...(message.thought === undefined ? {} : { thought: message.thought }),
        });
      } else {
        pending = { ...message, results: new Map() };
      }
      continue;
    }
    if (row.kind !== "tool_call") {
      if (pending !== null) {
        throw new Error("Assistant Tool exchange is incomplete");
      }
      messages.push(mapContextMessage(row));
      continue;
    }
    const event = mapToolEvent(row.payload);
    if (event.status === "in_progress") {
      continue;
    }
    if (pending === null) {
      throw new Error("Terminal Tool event has no matching assistant response");
    }
    if (!pending.toolCalls.some((call) => call.id === event.toolCallId)) {
      throw new Error("Terminal Tool event has no matching model call");
    }
    if (pending.results.has(event.toolCallId)) {
      throw new Error("Tool call has more than one terminal result");
    }
    pending.results.set(event.toolCallId, event.content);
    if (pending.results.size === pending.toolCalls.length) {
      const completed = pending;
      messages.push({
        sequence: completed.sequence,
        endSequence: Number(row.sequence),
        kind: "tool_exchange",
        assistant: {
          content: completed.content,
          ...(completed.thought === undefined ? {} : { thought: completed.thought }),
          toolCalls: completed.toolCalls,
        },
        results: completed.toolCalls.map((call) => ({
          toolCallId: call.id,
          content: requireResult(completed, call.id),
        })),
      });
      pending = null;
    }
  }
  if (pending !== null) {
    throw new Error("Assistant Tool exchange is incomplete");
  }
  return messages.sort((left, right) => left.sequence - right.sequence);
}

type PendingToolExchange = {
  sequence: number;
  endSequence?: number;
  content: ContentBlock[];
  thought?: ContentBlock[];
  toolCalls: Extract<StoredContextMessage, { kind: "tool_exchange" }>["assistant"]["toolCalls"];
  results: Map<string, ContentBlock[]>;
};

function mapAgentMessage(row: {
  sequence: string;
  endSequence?: number;
  payload: unknown;
}): Omit<PendingToolExchange, "results"> {
  const payload = asRecord(row.payload, "Agent message payload is invalid");
  return {
    sequence: Number(row.sequence),
    ...(row.endSequence === undefined ? {} : { endSequence: row.endSequence }),
    content: asContent(payload.content),
    ...(payload.thought === undefined ? {} : { thought: asContent(payload.thought) }),
    toolCalls: mapToolCalls(payload.toolCalls),
  };
}

type ContextRow = { sequence: string; kind: string; payload: unknown; endSequence?: number };

// Reasoning belongs to its assistant response, never to a later user or Tool result.
function attachThoughts(rows: ContextRow[]): ContextRow[] {
  const result: ContextRow[] = [];
  let thoughts: ContentBlock[] = [];
  let firstSequence: string | undefined;
  for (const row of rows) {
    if (row.kind === "agent_thought") {
      const payload = asRecord(row.payload, "Agent thought payload is invalid");
      firstSequence ??= row.sequence;
      thoughts.push(...asContent(payload.content));
      continue;
    }
    if (row.kind === "agent_message" && thoughts.length > 0) {
      const payload = asRecord(row.payload, "Agent message payload is invalid");
      result.push({
        ...row,
        sequence: firstSequence ?? row.sequence,
        endSequence: Number(row.sequence),
        payload: { ...payload, thought: joinTextBlocks(thoughts) },
      });
    } else result.push(row);
    thoughts = [];
    firstSequence = undefined;
  }
  return result;
}

// Durable delivery is chunked; the model and compaction see a whole assistant response.
function combineAssistantChunks(rows: ContextRow[]): ContextRow[] {
  const result: ContextRow[] = [];
  let activeId: string | undefined;
  for (const row of rows) {
    if (row.kind !== "agent_message") {
      activeId = undefined;
      result.push(row);
      continue;
    }
    const payload = asRecord(row.payload, "Agent message payload is invalid");
    const responseId = typeof payload.responseId === "string" ? payload.responseId : undefined;
    const previous = result.at(-1);
    if (responseId === undefined || activeId !== responseId || previous === undefined) {
      activeId = responseId;
      result.push({
        ...row,
        ...(responseId === undefined
          ? {}
          : { endSequence: row.endSequence ?? Number(row.sequence) }),
      });
      continue;
    }
    const prior = asRecord(previous.payload, "Agent message payload is invalid");
    previous.payload = {
      ...prior,
      ...payload,
      content: joinTextBlocks([...asContent(prior.content), ...asContent(payload.content)]),
      ...(prior.thought === undefined && payload.thought === undefined
        ? {}
        : {
            thought: joinTextBlocks([
              ...asContent(prior.thought ?? []),
              ...asContent(payload.thought ?? []),
            ]),
          }),
    };
    previous.endSequence = row.endSequence ?? Number(row.sequence);
  }
  return result;
}

function joinTextBlocks(content: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  for (const block of content) {
    const previous = result.at(-1);
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      previous?.type === "text" &&
      typeof previous.text === "string"
    ) {
      previous.text += block.text;
    } else {
      result.push({ ...block });
    }
  }
  return result;
}

function mapContextMessage(row: {
  sequence: string;
  kind: string;
  payload: unknown;
}): StoredContextMessage {
  const payload = asRecord(row.payload, "Session message payload is invalid");
  if (
    row.kind !== "user_message" &&
    row.kind !== "agent_message" &&
    row.kind !== "environment_change"
  ) {
    throw new Error(`Unsupported context message kind ${row.kind}`);
  }
  const content =
    row.kind === "environment_change"
      ? [{ type: "text", text: requireString(payload.content, "Environment fact is invalid") }]
      : asContent(payload.content);
  return { sequence: Number(row.sequence), kind: row.kind, content };
}

function mapToolEvent(value: unknown): {
  toolCallId: string;
  status: string;
  content: ContentBlock[];
} {
  const payload = asRecord(value, "Tool event payload is invalid");
  const toolCallId = requireString(payload.toolCallId, "Tool call ID is invalid");
  const status = requireString(payload.status, "Tool status is invalid");
  return {
    toolCallId,
    status,
    content:
      status === "in_progress"
        ? []
        : asContent(
            payload.content ?? [
              { type: "text", text: "Tool call completed without a retained result." },
            ],
          ),
  };
}

function mapToolCalls(value: unknown): PendingToolExchange["toolCalls"] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Agent Tool calls are invalid");
  }
  return value.map((item) => {
    const call = asRecord(item, "Agent Tool call is invalid");
    return {
      id: requireString(call.id, "Agent Tool call ID is invalid"),
      name: requireString(call.name, "Agent Tool name is invalid"),
      arguments: asRecord(call.arguments, "Agent Tool arguments are invalid"),
    };
  });
}

function requireResult(pending: PendingToolExchange, toolCallId: string): ContentBlock[] {
  const result = pending.results.get(toolCallId);
  if (result === undefined) {
    throw new Error("Assistant Tool exchange has no terminal result");
  }
  return result;
}

function asContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) {
    throw new Error("Session message content is invalid");
  }
  return value.map((block) => {
    const record = asRecord(block, "Session content block is invalid");
    requireString(record.type, "Session content block type is invalid");
    return record as ContentBlock;
  });
}

function asRecord(value: unknown, message: string): { [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as { [key: string]: unknown };
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}
