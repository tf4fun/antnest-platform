import { createHash } from "node:crypto";

import { assertModelInputBudget, estimateMessages } from "./context-budget.js";
import type { ProviderClientHandle } from "./provider-clients.js";
import type { ModelCallBudget } from "../domain/learning-budget.js";
import type { LearningEvidence } from "../domain/learning-evidence.js";
import {
  buildLearningReviewPrompt,
  parseLearningReviewProposal,
  type LearningReviewDecision,
} from "../domain/learning-review-proposal.js";
import type { LearningTaskClaim, LearningReviewPromptVersion } from "../domain/learning-scan.js";
import type { ModelMessage, RunExecutionSnapshot } from "../domain/types.js";
import { ModelError, type ModelPort } from "../ports/model.js";
import {
  NOOP_LEARNING_DIAGNOSTICS,
  type LearningReviewDiagnostics,
} from "../ports/learning-diagnostics.js";

type EvidenceSource = { readAndRecord(claim: LearningTaskClaim): Promise<LearningEvidence> };
type SnapshotSource = { readSnapshot(claim: LearningTaskClaim): Promise<RunExecutionSnapshot> };
type ModelAuthority = {
  assertCurrent(claim: LearningTaskClaim, snapshot: RunExecutionSnapshot): void;
};
type ProviderClientFactory = {
  acquire(organizationId: string, connectionId: string): ProviderClientHandle;
};
type ModelAdmission = {
  reserve(
    claim: LearningTaskClaim,
    requestId: string,
    budget: ModelCallBudget,
  ): Promise<{ callIndex: number; state: "reserved" | "settled" | "unknown"; dispatch: boolean }>;
  watch(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): {
    signal: AbortSignal;
    stop(): Promise<void>;
  };
};
type ReviewLedger = {
  settle(claim: LearningTaskClaim, requestId: string, actual: ModelCallBudget): Promise<void>;
  settleReview(
    claim: LearningTaskClaim,
    requestId: string,
    actual: ModelCallBudget,
    decision: LearningReviewDecision,
  ): Promise<void>;
  readReview(claim: LearningTaskClaim, requestId: string): Promise<unknown>;
  markUnknown(claim: LearningTaskClaim, requestId: string): Promise<void>;
};

const MAX_INPUT_TOKENS = 16_000;
const MAX_TOTAL_TIME_MS = 90_000;

export class LearningReviewRunner {
  public constructor(
    private readonly evidenceSource: EvidenceSource,
    private readonly snapshotSource: SnapshotSource,
    private readonly authority: ModelAuthority,
    private readonly admission: ModelAdmission,
    private readonly ledger: ReviewLedger,
    private readonly providers: ProviderClientFactory,
    private readonly diagnostics: LearningReviewDiagnostics = NOOP_LEARNING_DIAGNOSTICS,
  ) {}

  public async execute(input: {
    claim: LearningTaskClaim;
    signal: AbortSignal;
    existingSkills?: readonly { name: string; description: string; content?: string }[];
  }): Promise<LearningReviewDecision | null> {
    return this.diagnostics.review(input.claim, () => this.executeReview(input));
  }

  private async executeReview(input: {
    claim: LearningTaskClaim;
    signal: AbortSignal;
    existingSkills?: readonly { name: string; description: string; content?: string }[];
  }): Promise<LearningReviewDecision | null> {
    const { claim, signal } = input;
    signal.throwIfAborted();
    const snapshot = await this.snapshotSource.readSnapshot(claim);
    if (snapshot.organizationId !== claim.organizationId)
      throw new Error("Learning review model snapshot has a different organization");
    signal.throwIfAborted();
    const client = this.providers.acquire(claim.organizationId, snapshot.providerConnectionId);
    try {
      return await this.runWithClient(
        claim,
        snapshot,
        AbortSignal.any([signal, client.signal]),
        client,
        input.existingSkills ?? [],
      );
    } finally {
      client.release();
    }
  }

  private async runWithClient(
    claim: LearningTaskClaim,
    snapshot: RunExecutionSnapshot,
    signal: AbortSignal,
    model: ModelPort,
    existingSkills: readonly { name: string; description: string; content?: string }[],
  ): Promise<LearningReviewDecision | null> {
    signal.throwIfAborted();
    const evidence = await this.evidenceSource.readAndRecord(claim);
    if (evidence.sourceRunId !== claim.sourceRunId)
      throw new Error("Learning review evidence does not match the source Run");
    this.diagnostics.evidence(claim, evidence);
    const version = claim.reviewPromptVersion ?? 1;
    const prompt = buildLearningReviewPrompt(evidence, existingSkills, version);
    const messages: ModelMessage[] = [
      { role: "system", content: [{ type: "text", text: prompt.system }] },
      { role: "user", content: [{ type: "text", text: prompt.user }] },
    ];
    const beganAt = performance.now();
    for (const callIndex of [1, 2] as const) {
      signal.throwIfAborted();
      this.authority.assertCurrent(claim, snapshot);
      const remainingMs = Math.floor(MAX_TOTAL_TIME_MS - (performance.now() - beganAt));
      if (remainingMs <= 0) return null;
      const durationMs = callIndex === 1 ? 60_000 : 30_000;
      const timeoutMs = Math.min(durationMs, remainingMs);
      const maxOutputTokens = Math.min(
        snapshot.executionSpec.model.maxOutputTokens,
        callIndex === 1 ? 3_000 : 1_000,
      );
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
        throw new Error("Learning review model output limit is invalid");
      const reviewSnapshot = {
        ...snapshot,
        executionSpec: {
          ...snapshot.executionSpec,
          model: { ...snapshot.executionSpec.model, maxOutputTokens },
        },
      };
      assertModelInputBudget(reviewSnapshot, [], messages);
      const estimatedInput = Math.ceil(estimateMessages(messages) * 1.2);
      if (estimatedInput < 1 || estimatedInput > MAX_INPUT_TOKENS)
        throw new Error("Learning review input exceeds task budget");
      const allowance = { inputTokens: estimatedInput, outputTokens: maxOutputTokens, durationMs };
      const requestId = reviewRequestId(claim, callIndex);
      const receipt = await this.admission.reserve(claim, requestId, allowance);
      if (receipt.callIndex !== callIndex)
        throw new Error("Learning review model call index conflicts with its request");
      if (!receipt.dispatch) {
        if (receipt.state !== "settled")
          throw new Error("Learning review model call has an unknown outcome");
        const saved = await this.ledger.readReview(claim, requestId);
        if (saved !== null)
          return parseLearningReviewProposal(JSON.stringify(saved), evidence, version);
        if (callIndex === 1) {
          messages.push(repairMessage(version));
          continue;
        }
        return null;
      }
      const callStarted = performance.now();
      const policyWatch = this.admission.watch(claim, signal);
      const callSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(timeoutMs),
        policyWatch.signal,
      ]);
      const modelResult = await (async () => {
        try {
          return {
            ok: true as const,
            response: await this.diagnostics.modelCall(claim, callIndex, requestId, () =>
              completeReviewOrAbort(model, {
                purpose: "skill_learning",
                snapshot: reviewSnapshot,
                messages,
                tools: [],
                signal: callSignal,
              }),
            ),
          };
        } catch (error) {
          return { ok: false as const, error };
        } finally {
          await policyWatch.stop();
        }
      })();
      if (!modelResult.ok) {
        const usage = modelResult.error instanceof ModelError ? modelResult.error.usage : undefined;
        await this.settleKnownOrUnknown(
          claim,
          requestId,
          usage,
          Math.ceil(performance.now() - callStarted),
        );
        if (policyWatch.signal.aborted) throw policyWatch.signal.reason;
        throw modelResult.error;
      }
      const response = modelResult.response;
      const actual = usageBudget(response.usage, Math.ceil(performance.now() - callStarted));
      if (actual === null) {
        await this.ledger.markUnknown(claim, requestId);
        throw new Error("Learning review model usage is unknown");
      }
      if (policyWatch.signal.aborted) {
        await this.ledger.settle(claim, requestId, actual);
        throw policyWatch.signal.reason;
      }
      if (callSignal.aborted) {
        await this.ledger.settle(claim, requestId, actual);
        throw new Error("Learning review model call exceeded its active allowance");
      }
      try {
        this.authority.assertCurrent(claim, snapshot);
      } catch (error) {
        await this.ledger.settle(claim, requestId, actual);
        throw error;
      }
      const raw =
        response.kind === "message" &&
        response.stopReason === "end_turn" &&
        response.content.length === 1 &&
        response.content[0]?.type === "text" &&
        typeof response.content[0].text === "string"
          ? response.content[0].text
          : null;
      let decision: LearningReviewDecision | null = null;
      try {
        decision = await this.diagnostics.validate(claim, callIndex, response, () => {
          if (raw === null) throw new Error("Learning review response shape is invalid");
          return parseLearningReviewProposal(raw, evidence, version);
        });
      } catch {
        // One format repair is allowed; malformed output is not a candidate.
      }
      if (decision !== null) {
        await this.ledger.settleReview(claim, requestId, actual, decision);
        signal.throwIfAborted();
        return decision;
      }
      await this.ledger.settle(claim, requestId, actual);
      signal.throwIfAborted();
      if (callIndex === 2) return null;
      messages.push(repairMessage(version));
    }
    return null;
  }

  private async settleKnownOrUnknown(
    claim: LearningTaskClaim,
    requestId: string,
    usage: { inputTokens?: number; outputTokens?: number } | undefined,
    durationMs: number,
  ): Promise<void> {
    const actual = usageBudget(usage, durationMs);
    if (actual === null) await this.ledger.markUnknown(claim, requestId);
    else await this.ledger.settle(claim, requestId, actual);
  }
}

/** Only the tool-free inference may be detached; Runtime effects must still settle. */
async function completeReviewOrAbort(
  model: ModelPort,
  request: Parameters<ModelPort["complete"]>[0],
): ReturnType<ModelPort["complete"]> {
  request.signal.throwIfAborted();
  const response = model.complete(request);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", aborted);
      result();
    };
    const aborted = (): void => {
      const reason: unknown = request.signal.reason;
      finish(() => reject(reason instanceof Error ? reason : new Error("Learning review aborted")));
    };
    // Attach both handlers even after cancellation: a late response or error is
    // discarded, never published as a proposal, and never an unhandled rejection.
    void response.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error("Learning review failed"))),
    );
    request.signal.addEventListener("abort", aborted, { once: true });
    if (request.signal.aborted) aborted();
  });
}

function reviewRequestId(claim: LearningTaskClaim, callIndex: 1 | 2): string {
  return createHash("sha256")
    .update(JSON.stringify([claim.taskId, claim.claimId, claim.generation, callIndex]))
    .digest("hex");
}

function repairMessage(version: LearningReviewPromptVersion): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          version === 2
            ? 'This development debug review requires "decision":"propose"; "skip" is not accepted. Return the smallest evidence-supported proposal in the required JSON shape. Do not add new facts or citations.'
            : "Your previous response did not match the required JSON shape. Reassess only the supplied evidence and return one valid JSON decision. Do not add new facts or citations.",
      },
    ],
  };
}

function usageBudget(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  durationMs: number,
): ModelCallBudget | null {
  if (
    usage === undefined ||
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    (usage.inputTokens ?? -1) < 0 ||
    (usage.outputTokens ?? -1) < 0
  )
    return null;
  return { inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens!, durationMs };
}
