import type { NormalizedClientMcpSource } from "../domain/mcp.js";
import type { ConnectionBinding, SessionRecord } from "../domain/types.js";
import type { SessionEvent } from "./acp-application.js";

export type CreateSessionInput = {
  sessionId: string;
  binding: ConnectionBinding;
  cwd: "/workspace";
  mcpRevisionId: string;
  mcpSources: NormalizedClientMcpSource[];
};

export type ListSessionsInput = {
  principalId: string;
  agentId: string;
  cwd: string | undefined;
  cursor: string | undefined;
  limit: number;
};

export type ReplaceMcpInput = {
  sessionId: string;
  mcpRevisionId: string;
  mcpSources: NormalizedClientMcpSource[];
};

export interface SessionRepository {
  create(input: CreateSessionInput): Promise<void>;
  get(sessionId: string): Promise<SessionRecord | null>;
  list(input: ListSessionsInput): Promise<{
    sessions: SessionRecord[];
    nextCursor: string | undefined;
  }>;
  replaceMcpAndActivate(input: ReplaceMcpInput): Promise<SessionRecord>;
  replay(sessionId: string): Promise<SessionEvent[]>;
  getCurrentRunState(sessionId: string): Promise<Extract<SessionEvent, { kind: "state" }>>;
  requestCancellation(sessionId: string, requestedAt: Date): Promise<void>;
  close(sessionId: string, closedAt: Date): Promise<void>;
  delete(sessionId: string, deletedAt: Date): Promise<void>;
  getClientMcpRevision(revisionId: string): Promise<NormalizedClientMcpSource[]>;
}
