import type { LearningReviewDecision } from "../domain/learning-review-proposal.js";
import type { LearningEvidence } from "../domain/learning-evidence.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { ModelResult } from "./model.js";

export interface LearningReviewDiagnostics {
  evidence(claim: LearningTaskClaim, evidence: LearningEvidence): void;
  review(
    claim: LearningTaskClaim,
    operation: () => Promise<LearningReviewDecision | null>,
  ): Promise<LearningReviewDecision | null>;
  modelCall(
    claim: LearningTaskClaim,
    callIndex: number,
    requestId: string,
    operation: () => Promise<ModelResult>,
  ): Promise<ModelResult>;
  validate(
    claim: LearningTaskClaim,
    callIndex: number,
    response: ModelResult,
    operation: () => LearningReviewDecision,
  ): Promise<LearningReviewDecision>;
}

export const NOOP_LEARNING_DIAGNOSTICS: LearningReviewDiagnostics = {
  evidence: () => undefined,
  review: (_claim, operation) => operation(),
  modelCall: (_claim, _callIndex, _requestId, operation) => operation(),
  validate: (_claim, _callIndex, _response, operation) => Promise.resolve().then(operation),
};
