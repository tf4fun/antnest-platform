import type {
  LearningScanScope,
  LearningSource,
  LearningSkipReason,
  LearningReviewPromptVersion,
} from "../domain/learning-scan.js";
import type { LearningPolicy } from "../domain/learning-policy.js";

export type LearningPolicyReader = {
  read(scope: LearningScanScope): Promise<LearningPolicy>;
};

export type LearningScanStore = {
  activate(scope: LearningScanScope, revision: string, activationCut: string): Promise<void>;
  list(scope: LearningScanScope, limit: number): Promise<LearningSource[]>;
  recordSkip(scope: LearningScanScope, runId: string, reason: LearningSkipReason): Promise<void>;
  enqueue(
    scope: LearningScanScope,
    runId: string,
    policy: LearningPolicy,
    reviewPromptVersion?: LearningReviewPromptVersion,
  ): Promise<{ taskId: string } | null>;
};

export type LearningReviewCue = {
  hasCue(scope: LearningScanScope, source: LearningSource): Promise<boolean>;
};

export type LearningCueStore = {
  countExecutedToolRounds(scope: LearningScanScope, runId: string): Promise<number>;
  hasAuthenticatedCorrectionCue(scope: LearningScanScope, runId: string): Promise<boolean>;
  hasPriorSkillRead(scope: LearningScanScope, runId: string): Promise<boolean>;
};

export class PersistedLearningReviewCue implements LearningReviewCue {
  public constructor(private readonly store: LearningCueStore) {}

  public async hasCue(scope: LearningScanScope, source: LearningSource): Promise<boolean> {
    if (source.state !== "completed") return false;
    const toolRounds = await this.store.countExecutedToolRounds(scope, source.runId);
    if (toolRounds >= 3) return true;
    if (!(await this.store.hasAuthenticatedCorrectionCue(scope, source.runId))) return false;
    return this.store.hasPriorSkillRead(scope, source.runId);
  }
}

export class LearningScanCoordinator {
  public constructor(
    private readonly policyReader: LearningPolicyReader,
    private readonly store: LearningScanStore,
    private readonly cue: LearningReviewCue,
    private readonly debugAgentId?: string,
  ) {}

  public async scanPage(
    scope: LearningScanScope,
  ): Promise<{ decided: number; queued: number; queueFull: boolean }> {
    const policy = await this.policyReader.read(scope);
    if (policy.mode === "off") return { decided: 0, queued: 0, queueFull: false };
    await this.store.activate(scope, policy.revision, policy.activation_cut_at);
    const sources = await this.store.list(scope, 100);
    let decided = 0;
    let queued = 0;
    const debug = scope.agentId === this.debugAgentId;
    for (const source of sources) {
      if (source.state !== "completed") {
        await this.store.recordSkip(scope, source.runId, "failed_run");
      } else if (debug || (await this.cue.hasCue(scope, source))) {
        const task = debug
          ? await this.store.enqueue(scope, source.runId, policy, 2)
          : await this.store.enqueue(scope, source.runId, policy);
        if (task === null) return { decided, queued, queueFull: true };
        queued += 1;
      } else {
        await this.store.recordSkip(scope, source.runId, "no_review_cue");
      }
      decided += 1;
    }
    return { decided, queued, queueFull: false };
  }
}
