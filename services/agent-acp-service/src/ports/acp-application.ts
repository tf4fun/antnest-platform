import type {
  ConnectionBinding,
  ContentBlock,
  JsonValue,
  RunExecutionSnapshot,
  RunOutcome,
  RunStopReason,
} from "../domain/types.js";
import type { ClientMcpInput } from "../domain/mcp.js";
import type { SessionConfigurationView } from "../domain/session-configuration.js";
import type { PlanEntry } from "../domain/plan.js";
import type { SessionCommand } from "../domain/slash-commands.js";
import type { UsageUpdate } from "../domain/usage.js";
import type { ToolKind, ToolLocation, ToolFileObservation } from "../domain/tool-presentation.js";

export type AcpSessionInfo = {
  sessionId: string;
  cwd: "/workspace";
  title?: string;
  updatedAt?: string;
};

export type SessionEvent =
  | { kind: "configuration"; configuration: SessionConfigurationView }
  | { kind: "plan"; entries: PlanEntry[] }
  | {
      kind: "user_message";
      messageId: string;
      content: ContentBlock[];
    }
  | {
      kind: "agent_thought";
      messageId: string;
      responseId?: string;
      content: ContentBlock[];
    }
  | {
      kind: "agent_message";
      messageId: string;
      responseId?: string;
      content: ContentBlock[];
      toolCalls?: Array<{
        id: string;
        name: string;
        arguments: { [key: string]: unknown };
      }>;
    }
  | {
      kind: "tool_call";
      initial: true;
      file?: ToolFileObservation;
      toolKind?: ToolKind;
      locations?: ToolLocation[];
      rawOutput?: JsonValue;
      toolCallId: string;
      title: string;
      modelName?: string;
      arguments?: { [key: string]: unknown };
      status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
      content?: ContentBlock[];
    }
  | {
      kind: "tool_call";
      initial: false;
      file?: ToolFileObservation;
      toolKind?: ToolKind;
      locations?: ToolLocation[];
      rawOutput?: JsonValue;
      toolCallId: string;
      title?: string;
      modelName?: string;
      arguments?: { [key: string]: unknown };
      status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
      content?: ContentBlock[];
    }
  | ({ kind: "usage" } & UsageUpdate)
  | {
      kind: "state";
      state: "running" | "idle";
      stopReason?: RunStopReason | "cancelled" | "_failed" | "_unresolved";
    };

export interface SessionEventPublisher {
  publish(event: SessionEvent): Promise<void>;
}

export type SessionOutputSnapshot = {
  sequence: number;
  events: SessionEvent[];
  state: Extract<SessionEvent, { kind: "state" }>;
};

export type AcceptedAcpRun = {
  command?: SessionCommand;
  runId: string;
  requestId: string;
  sessionId: string;
  userMessageId: string;
  sessionInfoUpdate?: {
    title?: string;
    updatedAt: string;
  };
  snapshot: RunExecutionSnapshot;
};

export type ExecuteRunResult = RunOutcome;

export class RunRecoveryRequiredError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RunRecoveryRequiredError";
  }
}

export interface AcpApplicationPort {
  getSessionConfiguration(input: {
    binding: ConnectionBinding;
    sessionId: string;
  }): Promise<SessionConfigurationView>;
  setSessionConfiguration(input: {
    binding: ConnectionBinding;
    sessionId: string;
    configId: string;
    value: string | boolean;
  }): Promise<SessionConfigurationView>;
  readSessionOutput(input: {
    binding: ConnectionBinding;
    sessionId: string;
    afterSequence?: number;
  }): Promise<SessionOutputSnapshot>;
  assertAccess(input: { binding: ConnectionBinding }): Promise<void>;
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
  forkSession(input: {
    binding: ConnectionBinding;
    sessionId: string;
    cwd: string;
    additionalDirectories: string[];
    mcpServers: ClientMcpInput[];
  }): Promise<{ sessionId: string }>;
  resumeSession(input: {
    binding: ConnectionBinding;
    sessionId: string;
    cwd: string;
    additionalDirectories: string[];
    mcpServers: ClientMcpInput[];
    replayFromStart: boolean;
  }): Promise<{ replay: SessionEvent[]; sequence: number }>;
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
