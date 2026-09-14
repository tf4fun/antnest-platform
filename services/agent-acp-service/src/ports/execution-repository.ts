import type { RunOutcome, RunState } from "../domain/types.js";

export type RecoveryWork = {
  kind: "admitting" | "running";
  id: string;
};

export type FinishLocalRunInput = RunOutcome & {
  runId: string;
  finishedAt: Date;
};

export interface ExecutionRepository {
  getState(runId: string): Promise<RunState | null>;
  finish(input: FinishLocalRunInput): Promise<void>;
  listRecoveryWork(): Promise<RecoveryWork[]>;
}

export type RuntimeProtectionScope = {
  organizationId: string;
  agentId: string;
  runtimeRevision: string | null;
};

export interface RuntimeProtectionRepository {
  hasUnstoppedRuntimeCalls(scope: RuntimeProtectionScope, signal?: AbortSignal): Promise<boolean>;
}
