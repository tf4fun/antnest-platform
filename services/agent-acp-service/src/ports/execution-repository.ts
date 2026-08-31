import type { ContentBlock, RunOutcome, RunExecutionSnapshot, RunState } from "../domain/types.js";

export type RecoveryWork =
  | {
      kind: "admitting";
      id: string;
      requestId: string;
      sessionId: string;
      clientMcpRevisionId: string;
      expectedAccessRevision: string;
      userMessageId: string;
      prompt: ContentBlock[];
    }
  | {
      kind: "running";
      id: string;
      requestId: string;
      sessionId: string;
      snapshot: RunExecutionSnapshot;
    }
  | ({
      kind: "finish_admission";
      id: string;
      admissionId: string;
    } & RunOutcome)
  | {
      kind: "invalid";
      id: string;
      previousState: RunState;
      admissionId?: string;
      errorClass: "invalid_recovery_record";
    };

export type FinishLocalRunInput = RunOutcome & {
  runId: string;
  finishedAt: Date;
};

export interface ExecutionRepository {
  getState(runId: string): Promise<RunState | null>;
  finish(input: FinishLocalRunInput): Promise<void>;
  quarantine(runId: string, errorClass: string, finishedAt: Date): Promise<void>;
  markAdmissionFinished(runId: string, finishedAt: Date): Promise<void>;
  listRecoveryWork(): Promise<RecoveryWork[]>;
}
