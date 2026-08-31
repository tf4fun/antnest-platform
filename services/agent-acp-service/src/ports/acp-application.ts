import type {
  ConnectionBinding,
  ContentBlock,
  ExecutorState,
  RunExecutionSnapshot,
  RuntimeEffectState,
  TerminalClass,
} from "../domain/types.js";
import type { ClientMcpInput } from "../domain/mcp.js";

export type AcpSessionInfo = {
  sessionId: string;
  cwd: "/workspace";
  title?: string;
  updatedAt?: string;
};

export type SessionEvent =
  | {
      kind: "user_message" | "agent_message" | "agent_thought";
      messageId: string;
      content: ContentBlock[];
    }
  | {
      kind: "tool_call";
      toolCallId: string;
      title?: string;
      status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
      content?: ContentBlock[];
    }
  | {
      kind: "usage";
      used: number;
      size: number;
    }
  | {
      kind: "state";
      state: "running" | "idle";
      stopReason?: "end_turn" | "cancelled" | "_failed" | "_unresolved";
    };

export interface SessionEventPublisher {
  publish(event: SessionEvent): Promise<void>;
}

export type AcceptedAcpRun = {
  runId: string;
  requestId: string;
  sessionId: string;
  userMessageId: string;
  snapshot: RunExecutionSnapshot;
};

export type ExecuteRunResult = {
  terminalClass: TerminalClass;
  executorState: ExecutorState;
  runtimeEffectState: RuntimeEffectState;
  errorClass?: string;
};

export interface AcpApplicationPort {
  createSession(input: {
    binding: ConnectionBinding;
    cwd: string;
    additionalDirectories: string[];
    mcpServers: ClientMcpInput[];
  }): Promise<{ sessionId: string }>;
  listSessions(input: {
    binding: ConnectionBinding;
    cwd?: string;
    cursor?: string;
  }): Promise<{ sessions: AcpSessionInfo[]; nextCursor?: string }>;
  deleteSession(input: { binding: ConnectionBinding; sessionId: string }): Promise<void>;
  resumeSession(input: {
    binding: ConnectionBinding;
    sessionId: string;
    cwd: string;
    additionalDirectories: string[];
    mcpServers: ClientMcpInput[];
    replayFromStart: boolean;
  }): Promise<{ replay: SessionEvent[] }>;
  closeSession(input: { binding: ConnectionBinding; sessionId: string }): Promise<void>;
  cancelRun(input: { binding: ConnectionBinding; sessionId: string }): Promise<void>;
  acceptPrompt(input: {
    binding: ConnectionBinding;
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<AcceptedAcpRun>;
  executeRun(input: {
    accepted: AcceptedAcpRun;
    publish: SessionEventPublisher["publish"];
    signal: AbortSignal;
  }): Promise<ExecuteRunResult>;
}
