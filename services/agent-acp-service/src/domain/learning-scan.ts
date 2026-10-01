export type LearningScanScope = {
  organizationId: string;
  agentId: string;
  ownerId: string;
};

export type LearningSource = {
  runId: string;
  sessionId: string;
  state: "completed" | "failed" | "cancelled" | "unresolved";
  createdAt: string;
  finishedAt: string;
};

export type LearningSkipReason =
  "no_review_cue" | "failed_run" | "policy_off" | "access_revoked" | "source_unavailable";

export type LearningPauseReason =
  | "foreground_preempted"
  | "worker_lost"
  | "lifecycle_closed"
  | "writer_present"
  | "access_revoked"
  | "unknown_effect"
  | "model_unavailable"
  | "policy_changed"
  | "runtime_unavailable"
  | "review_inconclusive";

export type LearningReviewPromptVersion = 1 | 2;

export type LearningTaskClaim = {
  taskId: string;
  claimId: string;
  generation: number;
  organizationId: string;
  agentId: string;
  ownerId: string;
  sourceRunId: string;
  frozenPolicy: unknown;
  reviewPromptVersion?: LearningReviewPromptVersion;
};

export type LearningClaimCandidate = Pick<
  LearningTaskClaim,
  | "taskId"
  | "organizationId"
  | "agentId"
  | "ownerId"
  | "sourceRunId"
  | "frozenPolicy"
  | "reviewPromptVersion"
>;
