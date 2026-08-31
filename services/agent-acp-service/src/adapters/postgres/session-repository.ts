import type { PoolClient } from "pg";

import type { NormalizedClientMcpSource } from "../../domain/mcp.js";
import type { SessionRecord } from "../../domain/types.js";
import type { SessionEvent } from "../../ports/acp-application.js";
import type {
  CreateSessionInput,
  ListSessionsInput,
  ReplaceMcpInput,
  SessionRepository,
} from "../../ports/session-repository.js";
import type { PostgresKernel } from "./kernel.js";
import type { SecretBox } from "./secret-box.js";

type SessionRow = {
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
};

export class PostgresSessionRepository implements SessionRepository {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly secretBox: SecretBox,
  ) {}

  public async create(input: CreateSessionInput): Promise<void> {
    const now = new Date();
    await this.kernel.transaction(async (client) => {
      await client.query(
        `INSERT INTO acp_sessions(
           id, principal_id, agent_id, cwd, state,
           client_mcp_revision_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', NULL, $5, $5)`,
        [input.sessionId, input.binding.principalId, input.binding.agentId, input.cwd, now],
      );
      await this.insertMcpRevision(
        client,
        input.sessionId,
        input.mcpRevisionId,
        1,
        input.mcpSources,
        now,
      );
      await client.query("UPDATE acp_sessions SET client_mcp_revision_id = $2 WHERE id = $1", [
        input.sessionId,
        input.mcpRevisionId,
      ]);
    });
  }

  public async get(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.kernel.query<SessionRow>(
      `SELECT id, principal_id, agent_id, cwd, state, client_mcp_revision_id,
              last_execution_revision, last_message_sequence, created_at, updated_at
         FROM acp_sessions WHERE id = $1`,
      [sessionId],
    );
    return result.rows[0] === undefined ? null : mapSession(result.rows[0]);
  }

  public async list(input: ListSessionsInput): Promise<{
    sessions: SessionRecord[];
    nextCursor: string | undefined;
  }> {
    const cursor = decodeCursor(input.cursor);
    const result = await this.kernel.query<SessionRow>(
      `SELECT id, principal_id, agent_id, cwd, state, client_mcp_revision_id,
              last_execution_revision, last_message_sequence, created_at, updated_at
         FROM acp_sessions
        WHERE principal_id = $1
          AND agent_id = $2
          AND state <> 'deleted'
          AND ($3::text IS NULL OR cwd = $3)
          AND ($4::timestamptz IS NULL OR (updated_at, id) < ($4, $5))
        ORDER BY updated_at DESC, id DESC
        LIMIT $6`,
      [
        input.principalId,
        input.agentId,
        input.cwd ?? null,
        cursor?.updatedAt ?? null,
        cursor?.id ?? null,
        input.limit + 1,
      ],
    );
    const hasMore = result.rows.length > input.limit;
    const visible = result.rows.slice(0, input.limit);
    const last = visible.at(-1);
    return {
      sessions: visible.map(mapSession),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ updatedAt: last.updated_at.toISOString(), id: last.id })
          : undefined,
    };
  }

  public async replaceMcpAndActivate(input: ReplaceMcpInput): Promise<SessionRecord> {
    return this.kernel.transaction(async (client) => {
      const session = await selectSessionForUpdate(client, input.sessionId);
      if (session.state === "deleted") {
        throw new Error("Session does not exist");
      }
      const revision = await client.query<{ next_revision: string }>(
        "SELECT COALESCE(max(revision), 0) + 1 AS next_revision FROM client_mcp_revisions WHERE session_id = $1",
        [input.sessionId],
      );
      const nextRevision = Number(revision.rows[0]?.next_revision ?? "1");
      const now = new Date();
      await this.insertMcpRevision(
        client,
        input.sessionId,
        input.mcpRevisionId,
        nextRevision,
        input.mcpSources,
        now,
      );
      const updated = await client.query<SessionRow>(
        `UPDATE acp_sessions
            SET client_mcp_revision_id = $2, state = 'active', updated_at = $3
          WHERE id = $1
        RETURNING id, principal_id, agent_id, cwd, state, client_mcp_revision_id,
                  last_execution_revision, last_message_sequence, created_at, updated_at`,
        [input.sessionId, input.mcpRevisionId, now],
      );
      return mapSession(requireRow(updated.rows[0], "Session update failed"));
    });
  }

  public async replay(sessionId: string): Promise<SessionEvent[]> {
    const result = await this.kernel.query<{ payload: SessionEvent }>(
      `SELECT payload FROM session_messages
        WHERE session_id = $1 AND visible
        ORDER BY sequence`,
      [sessionId],
    );
    return result.rows.map((row) => row.payload);
  }

  public async getCurrentRunState(
    sessionId: string,
  ): Promise<Extract<SessionEvent, { kind: "state" }>> {
    const result = await this.kernel.query<{
      state: "admitting" | "running" | "completed" | "cancelled" | "failed" | "unresolved";
      stop_reason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | null;
    }>(
      `SELECT state, stop_reason
         FROM runs
        WHERE session_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [sessionId],
    );
    switch (result.rows[0]?.state) {
      case "admitting":
      case "running":
        return { kind: "state", state: "running" };
      case "completed": {
        const stopReason = result.rows[0].stop_reason;
        if (stopReason === null) {
          throw new Error("Completed Run has no stop reason");
        }
        return {
          kind: "state",
          state: "idle",
          stopReason,
        };
      }
      case "cancelled":
        return { kind: "state", state: "idle", stopReason: "cancelled" };
      case "failed":
        return { kind: "state", state: "idle", stopReason: "_failed" };
      case "unresolved":
        return { kind: "state", state: "idle", stopReason: "_unresolved" };
      case undefined:
        return { kind: "state", state: "idle" };
    }
  }

  public async requestCancellation(sessionId: string, requestedAt: Date): Promise<void> {
    await this.kernel.transaction(async (client) => {
      const session = await selectSessionForUpdate(client, sessionId);
      if (session.state === "deleted") {
        throw new Error("Session does not exist");
      }
      await markRunsCancelled(client, sessionId, requestedAt);
    });
  }

  public async close(sessionId: string, closedAt: Date): Promise<void> {
    await this.setState(sessionId, "closed", closedAt);
  }

  public async delete(sessionId: string, deletedAt: Date): Promise<void> {
    await this.setState(sessionId, "deleted", deletedAt);
  }

  public async getClientMcpRevision(revisionId: string): Promise<NormalizedClientMcpSource[]> {
    const result = await this.kernel.query<{ encrypted_sources: Buffer; nonce: Buffer }>(
      "SELECT encrypted_sources, nonce FROM client_mcp_revisions WHERE id = $1",
      [revisionId],
    );
    const row = requireRow(result.rows[0], "Client MCP revision does not exist");
    return this.secretBox.open<NormalizedClientMcpSource[]>(
      { ciphertext: row.encrypted_sources, nonce: row.nonce },
      revisionId,
    );
  }

  private async setState(
    sessionId: string,
    state: "closed" | "deleted",
    changedAt: Date,
  ): Promise<void> {
    await this.kernel.transaction(async (client) => {
      const session = await selectSessionForUpdate(client, sessionId);
      if (session.state === "deleted") {
        throw new Error("Session does not exist");
      }
      await client.query("UPDATE acp_sessions SET state = $2, updated_at = $3 WHERE id = $1", [
        sessionId,
        state,
        changedAt,
      ]);
      await markRunsCancelled(client, sessionId, changedAt);
    });
  }

  private async insertMcpRevision(
    client: PoolClient,
    sessionId: string,
    revisionId: string,
    revision: number,
    sources: NormalizedClientMcpSource[],
    createdAt: Date,
  ): Promise<void> {
    const sealed = this.secretBox.seal(sources, revisionId);
    await client.query(
      `INSERT INTO client_mcp_revisions(
         id, session_id, revision, encrypted_sources, nonce, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [revisionId, sessionId, revision, sealed.ciphertext, sealed.nonce, createdAt],
    );
  }
}

async function markRunsCancelled(
  client: PoolClient,
  sessionId: string,
  requestedAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE runs
        SET cancel_requested_at = COALESCE(cancel_requested_at, $2), updated_at = $2
      WHERE session_id = $1 AND state IN ('admitting', 'running')`,
    [sessionId, requestedAt],
  );
}

async function selectSessionForUpdate(client: PoolClient, sessionId: string): Promise<SessionRow> {
  const result = await client.query<SessionRow>(
    `SELECT id, principal_id, agent_id, cwd, state, client_mcp_revision_id,
            last_execution_revision, last_message_sequence, created_at, updated_at
       FROM acp_sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  return requireRow(result.rows[0], "Session does not exist");
}

function mapSession(row: SessionRow): SessionRecord {
  return {
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

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message);
  }
  return row;
}

type Cursor = { updatedAt: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof decoded.updatedAt !== "string" || typeof decoded.id !== "string") {
      throw new Error("invalid cursor");
    }
    return { updatedAt: decoded.updatedAt, id: decoded.id };
  } catch {
    throw new Error("Session list cursor is invalid");
  }
}
