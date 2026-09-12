import type { AgentExecutionSpec, RunOutcome, RuntimeBinding } from "../domain/types.js";
import type {
  ConfigurationCatalog,
  SessionConfiguration,
} from "../domain/session-configuration.js";

export type ResolveAgentAccessInput = {
  requestId: string;
  agentAccessSubject: string;
};

export const AGENT_CONTROLLER_ERROR_CODES = [
  "access_denied",
  "agent_not_found",
  "agent_busy",
  "agent_rebuilding",
  "agent_build_failed",
  "agent_not_ready",
  "admission_not_found",
  "credential_not_allowed",
  "invalid_request",
  "dependency_unavailable",
  "internal_error",
  "model_unavailable",
  "configuration_conflict",
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
    audio?: boolean;
  };
};

export type AcquireRunInput = {
  sessionConfiguration?: SessionConfiguration;
  requestId: string;
  agentId: string;
  principalId: string;
  expectedAccessRevision: string;
  sessionId: string;
};

export type AcquireRunResult = {
  admissionId: string;
  admissionDeadline: Date;
  agentSpecRevision: string;
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

export type FinishRunInput = RunOutcome & {
  requestId: string;
  admissionId: string;
};

export function finishRunInput(
  requestId: string,
  admissionId: string,
  outcome: RunOutcome,
): FinishRunInput {
  switch (outcome.terminalClass) {
    case "completed":
    case "cancelled":
    case "failed":
    case "unresolved":
      return { requestId, admissionId, ...outcome };
  }
}

export interface AgentControllerPort {
  getSessionConfiguration(
    input: {
      requestId: string;
      agentId: string;
      principalId: string;
      expectedAccessRevision: string;
      afterId?: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<ConfigurationCatalog & { nextCursor: string }>;
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
