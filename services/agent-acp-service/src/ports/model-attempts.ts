import type { ModelUsage } from "../domain/usage.js";

export type ModelAttemptStarted = {
  ordinal: number;
  modelProfileId: string;
  providerConnectionId: string;
  model: string;
  purpose: "foreground" | "permission_judge" | "skill_learning";
  startedAt: Date;
};

export type ModelAttemptFinished = {
  ordinal: number;
  outcome: "completed" | "failed" | "cancelled";
  reason: string;
  durationMs: number;
  outputStarted: boolean;
  usage: ModelUsage;
  status?: number;
  finishedAt: Date;
};

export interface ModelAttemptPort {
  start(runId: string, fact: ModelAttemptStarted): Promise<void>;
  finish(runId: string, fact: ModelAttemptFinished): Promise<void>;
}
