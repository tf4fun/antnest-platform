import type { RunOutcome, RunState } from "../domain/types.js";
import type { AgentOwnershipScope } from "../domain/agent-ownership.js";

export type RecoveryWork = {
  kind: "admitting" | "running";
  id: string;
};

export type FinishLocalRunInput = RunOutcome & {
  runId: string;
  finishedAt: Date;
};

export type RunRecoveryState =
  { kind: "admitting" | "running" } | { kind: "terminal"; outcome: RunOutcome };

export interface RunRecoveryReader {
  getRecoveryState(runId: string): Promise<RunRecoveryState | null>;
}

export interface ExecutionRepository {
  getState(runId: string): Promise<RunState | null>;
  finish(input: FinishLocalRunInput): Promise<void>;
  listRecoveryWork(scope?: AgentOwnershipScope): Promise<RecoveryWork[]>;
}

export type RuntimeProtectionScope = {
  organizationId: string;
  agentId: string;
  runtimeRevision: string | null;
};

export interface RuntimeProtectionRepository {
  hasUnstoppedRuntimeCalls(scope: RuntimeProtectionScope, signal?: AbortSignal): Promise<boolean>;
}
