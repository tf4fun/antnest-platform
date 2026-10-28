import type { ModelUsage } from "../domain/usage.js";
import type { ModelReservation, ModelBudgetSettlement } from "../domain/model-budget.js";

export type ModelAttemptStarted = {
  ordinal: number;
  modelProfileId: string;
  providerConnectionId: string;
  model: string;
  purpose: "foreground" | "permission_judge" | "skill_learning";
  startedAt: Date;
  reservation?: ModelReservation;
};

export type ModelAttemptFinished = {
  ordinal: number;
  outcome: "completed" | "failed" | "cancelled";
  reason: string;
  durationMs: number;
  outputStarted: boolean;
  usage: ModelUsage;
  /** Internal proof: the original call joined without invoking its send boundary. */
  notDispatched?: true;
  contextSize?: number;
  status?: number;
  finishedAt: Date;
};

export interface ModelAttemptPort {
  start(runId: string, fact: ModelAttemptStarted): Promise<void>;
  finish(runId: string, fact: ModelAttemptFinished): Promise<ModelBudgetSettlement | void>;
}
