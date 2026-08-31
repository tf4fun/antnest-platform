import type {
  AgentExecutionSpec,
  ExecutorState,
  RuntimeBinding,
  RuntimeEffectState,
  TerminalClass,
} from "../domain/types.js";

export type ResolveAgentAccessInput = {
  requestId: string;
  authenticatedSubject: string;
};

export const AGENT_CONTROLLER_ERROR_CODES = [
  "access_denied",
  "agent_not_found",
  "agent_busy",
  "agent_rebuilding",
  "agent_build_failed",
  "admission_not_found",
  "credential_not_allowed",
  "invalid_request",
  "dependency_unavailable",
  "internal_error",
] as const;

export type AgentControllerErrorCode = (typeof AGENT_CONTROLLER_ERROR_CODES)[number];

const agentControllerErrorCodes: ReadonlySet<string> = new Set(AGENT_CONTROLLER_ERROR_CODES);

export function isAgentControllerErrorCode(value: string): value is AgentControllerErrorCode {
  return agentControllerErrorCodes.has(value);
}

export class AgentControllerError extends Error {
  public constructor(
    public readonly code: AgentControllerErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentControllerError";
  }
}

export type ResolveAgentAccessResult = {
  principalId: string;
  agentId: string;
  accessRevision: string;
  promptCapabilities: {
    image: boolean;
    embeddedContext: boolean;
  };
};

export type AcquireRunInput = {
  requestId: string;
  agentId: string;
  sessionId: string;
};

export type AcquireRunResult = {
  admissionId: string;
  admissionDeadline: Date;
  agentConfigRevision: string;
  executionRevision: string;
  runtimeMcpSourceDigest: string;
  agentExecutionSpecDigest: string;
  credentialVersion: string;
  runtime: RuntimeBinding;
  executionSpec: AgentExecutionSpec;
};

export type ResolveCredentialInput = {
  requestId: string;
  admissionId: string;
  credentialRef: string;
};

export type ResolveCredentialResult = {
  credentialVersion: string;
  secretType: "bearer";
  secret: string;
};

export type FinishRunInput = {
  requestId: string;
  admissionId: string;
  terminalClass: TerminalClass;
  executorState: ExecutorState;
  runtimeEffectState: RuntimeEffectState;
  errorClass?: string;
};

export interface AgentControllerPort {
  resolveAgentAccess(
    input: ResolveAgentAccessInput,
    signal?: AbortSignal,
  ): Promise<ResolveAgentAccessResult>;
  acquireRun(input: AcquireRunInput, signal?: AbortSignal): Promise<AcquireRunResult>;
  resolveCredential(
    input: ResolveCredentialInput,
    signal?: AbortSignal,
  ): Promise<ResolveCredentialResult>;
  finishRun(input: FinishRunInput, signal?: AbortSignal): Promise<void>;
}
