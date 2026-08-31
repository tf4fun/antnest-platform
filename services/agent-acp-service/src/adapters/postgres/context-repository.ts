import type { ContentBlock } from "../../domain/types.js";
import type {
  ContextCheckpoint,
  ContextRepository,
  ContextSource,
  SaveCheckpointInput,
  StoredContextMessage,
} from "../../ports/context-repository.js";
import type { PostgresKernel } from "./kernel.js";

export class PostgresContextRepository implements ContextRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async load(sessionId: string): Promise<ContextSource> {
    const checkpointResult = await this.kernel.query<{
      through_sequence: string;
      summary: string;
    }>(
      `SELECT through_sequence, summary
         FROM context_checkpoints
        WHERE session_id = $1
        ORDER BY through_sequence DESC
        LIMIT 1`,
      [sessionId],
    );
    const checkpoint = mapCheckpoint(checkpointResult.rows[0]);
    const messagesResult = await this.kernel.query<{
      sequence: string;
      kind: string;
      payload: unknown;
    }>(
      `SELECT sequence, kind, payload
         FROM session_messages
        WHERE session_id = $1
          AND sequence > $2
          AND kind IN ('user_message', 'agent_message', 'environment_change')
        ORDER BY sequence`,
      [sessionId, checkpoint?.throughSequence ?? 0],
    );
    return {
      checkpoint,
      messages: messagesResult.rows.map(mapContextMessage),
    };
  }

  public async saveCheckpoint(input: SaveCheckpointInput): Promise<void> {
    await this.kernel.query(
      `INSERT INTO context_checkpoints(
         id, session_id, through_sequence, summary, token_count, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, through_sequence) DO NOTHING`,
      [
        input.id,
        input.sessionId,
        input.throughSequence,
        input.summary,
        input.tokenCount,
        input.createdAt,
      ],
    );
  }
}

function mapCheckpoint(
  row: { through_sequence: string; summary: string } | undefined,
): ContextCheckpoint | null {
  if (row === undefined) {
    return null;
  }
  return {
    throughSequence: Number(row.through_sequence),
    summary: row.summary,
  };
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
