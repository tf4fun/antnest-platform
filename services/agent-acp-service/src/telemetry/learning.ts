import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { SEMCONV } from "./semconv.gen.js";
import { normalizeAttributes } from "./names.js";
import { ZodError } from "zod";

import type { LearningTaskProcessor } from "../application/learning-task-processor.js";
import type { LearningApplyAttempt } from "../application/learning-apply-attempt.js";
import {
  DebugLearningSkipError,
  type LearningReviewDecision,
} from "../domain/learning-review-proposal.js";
import type { LearningEvidence } from "../domain/learning-evidence.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { LearningReviewDiagnostics } from "../ports/learning-diagnostics.js";
import type { ModelResult } from "../ports/model.js";
import type { TelemetryAttributes, TelemetryPort } from "../ports/telemetry.js";

function identity(claim: LearningTaskClaim): TelemetryAttributes {
  return {
    [SEMCONV.ANTNEST_ORGANIZATION_ID]: claim.organizationId,
    [SEMCONV.ANTNEST_AGENT_ID]: claim.agentId,
    [SEMCONV.ANTNEST_LEARNING_SOURCE_RUN_ID]: claim.sourceRunId,
    [SEMCONV.ANTNEST_LEARNING_TASK_ID]: claim.taskId,
    [SEMCONV.ANTNEST_LEARNING_GENERATION]: claim.generation,
    [SEMCONV.ANTNEST_LEARNING_REVIEW_PROMPT_VERSION]: claim.reviewPromptVersion ?? 1,
    [SEMCONV.ANTNEST_LEARNING_DEBUG]: claim.reviewPromptVersion === 2,
  };
}

function attributes(value: TelemetryAttributes): void {
  trace
    .getSpan(context.active())
    ?.setAttributes(
      normalizeAttributes(
        Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
          ),
        ),
      ),
    );
}

export class InstrumentedLearningTaskProcessor {
  public constructor(
    private readonly delegate: Pick<LearningTaskProcessor, "process">,
    private readonly telemetry: TelemetryPort,
  ) {}

  public process(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): ReturnType<LearningTaskProcessor["process"]> {
    return this.telemetry.span("skill_learning.task", identity(claim), async () => {
      const result = await this.delegate.process(claim, signal);
      attributes({
        [SEMCONV.ANTNEST_LEARNING_OUTCOME]: result.kind,
        [SEMCONV.ANTNEST_LEARNING_PAUSE_REASON]:
          result.kind === "paused" ? result.reason : undefined,
        [SEMCONV.ANTNEST_LEARNING_CHANGE_ID]:
          result.kind === "applied" ? result.changeId : undefined,
      });
      if (
        result.kind === "failed" ||
        (result.kind === "paused" && result.reason === "review_inconclusive")
      )
        trace.getSpan(context.active())?.setStatus({ code: SpanStatusCode.ERROR });
      this.telemetry.count(SEMCONV.ANTNEST_ACP_SKILL_LEARNING_TASKS, {
        result: result.kind,
        reason: result.kind === "paused" ? result.reason : undefined,
      });
      return result;
    });
  }
}

export class InstrumentedLearningApply {
  public constructor(
    private readonly delegate: Pick<LearningApplyAttempt, "apply">,
    private readonly telemetry: TelemetryPort,
  ) {}

  public apply(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): ReturnType<LearningApplyAttempt["apply"]> {
    return this.telemetry.span("skill_learning.apply", identity(claim), async () => {
      const result = await this.delegate.apply(claim, signal);
      attributes({ [SEMCONV.ANTNEST_LEARNING_APPLY_OUTCOME]: result.kind });
      return result;
    });
  }
}

export class LearningTelemetry implements LearningReviewDiagnostics {
  public constructor(private readonly telemetry: TelemetryPort) {}

  public evidence(claim: LearningTaskClaim, evidence: LearningEvidence): void {
    attributes({
      ...identity(claim),
      [SEMCONV.ANTNEST_LEARNING_EVIDENCE_TRUNCATED]: evidence.truncated,
      [SEMCONV.ANTNEST_LEARNING_EVIDENCE_ITEMS]: evidence.items.length,
      [SEMCONV.ANTNEST_LEARNING_EVIDENCE_USER_ITEMS]: evidence.items.filter(
        (item) => item.kind === "authenticated_user",
      ).length,
      [SEMCONV.ANTNEST_LEARNING_EVIDENCE_EXECUTION_ITEMS]: evidence.items.filter(
        (item) => item.kind === "observed_execution",
      ).length,
      [SEMCONV.ANTNEST_LEARNING_EVIDENCE_UNTRUSTED_ITEMS]: evidence.items.filter(
        (item) => item.kind === "untrusted_material",
      ).length,
      [SEMCONV.ANTNEST_LEARNING_EVIDENCE_CONTENT_BYTES]: evidence.items.reduce(
        (total, item) => total + Buffer.byteLength(item.text),
        0,
      ),
    });
  }

  public review(claim: LearningTaskClaim, operation: () => Promise<LearningReviewDecision | null>) {
    return this.telemetry.span("skill_learning.review", identity(claim), async () => {
      const decision = await operation();
      attributes({
        [SEMCONV.ANTNEST_LEARNING_REVIEW_DECISION]: decision?.decision ?? "inconclusive",
      });
      return decision;
    });
  }

  public modelCall(
    claim: LearningTaskClaim,
    callIndex: number,
    requestId: string,
    operation: () => Promise<ModelResult>,
  ) {
    return this.telemetry.span(
      "skill_learning.review.call",
      {
        ...identity(claim),
        [SEMCONV.ANTNEST_LEARNING_CALL_INDEX]: callIndex,
        [SEMCONV.ANTNEST_REQUEST_ID]: requestId,
      },
      async () => {
        const result = await operation();
        attributes(responseAttributes(result));
        return result;
      },
    );
  }

  public validate(
    claim: LearningTaskClaim,
    callIndex: number,
    response: ModelResult,
    operation: () => LearningReviewDecision,
  ) {
    return this.telemetry.span(
      "skill_learning.review.validate",
      {
        ...identity(claim),
        [SEMCONV.ANTNEST_LEARNING_CALL_INDEX]: callIndex,
        ...responseAttributes(response),
      },
      async () => {
        try {
          const decision = await Promise.resolve().then(operation);
          attributes({ [SEMCONV.ANTNEST_LEARNING_VALIDATION_RESULT]: "accepted" });
          return decision;
        } catch (error) {
          const failure = validationFailure(response, error);
          attributes({
            [SEMCONV.ANTNEST_LEARNING_VALIDATION_RESULT]: "rejected",
            [SEMCONV.ANTNEST_LEARNING_VALIDATION_REASON]: failure.reason,
            [SEMCONV.ANTNEST_LEARNING_VALIDATION_PATHS]: failure.paths,
            [SEMCONV.ANTNEST_LEARNING_VALIDATION_CODES]: failure.codes,
          });
          this.telemetry.log("warn", "skill_learning_review_rejected", {
            ...identity(claim),
            call_index: callIndex,
            ...failure,
          });
          throw error;
        }
      },
    );
  }
}

function responseAttributes(response: ModelResult): TelemetryAttributes {
  const byteCount = (blocks: ModelResult["content"]) =>
    blocks.reduce(
      (sum, block) =>
        sum +
        (block.type === "text" && typeof block.text === "string"
          ? Buffer.byteLength(block.text)
          : 0),
      0,
    );
  return {
    [SEMCONV.ANTNEST_MODEL_RESULT_KIND]: response.kind,
    [SEMCONV.ANTNEST_MODEL_STOP_REASON]:
      response.kind === "message" ? response.stopReason : "tool_calls",
    [SEMCONV.ANTNEST_MODEL_CONTENT_BYTES]: byteCount(response.content),
    [SEMCONV.ANTNEST_MODEL_THOUGHT_BYTES]: byteCount(response.thought ?? []),
    [SEMCONV.ANTNEST_MODEL_MARKDOWN_FENCE]: response.content.some(
      (block) =>
        block.type === "text" && typeof block.text === "string" && /^\s*```/u.test(block.text),
    ),
    "gen_ai.usage.input_tokens": response.usage.inputTokens,
    "gen_ai.usage.output_tokens": response.usage.outputTokens,
  };
}

const fields = new Set([
  "decision",
  "reason",
  "name",
  "description",
  "instructions",
  "rules",
  "text",
  "evidenceIds",
]);
function validationFailure(
  response: ModelResult,
  error: unknown,
): { reason: string; paths?: string; codes?: string } {
  if (error instanceof DebugLearningSkipError) return { reason: "debug_skip" };
  if (response.kind !== "message") return { reason: "unexpected_tool_calls" };
  if (response.stopReason === "max_tokens") return { reason: "output_limit" };
  if (response.stopReason === "refusal") return { reason: "refusal" };
  if (
    response.content.length !== 1 ||
    response.content[0]?.type !== "text" ||
    typeof response.content[0].text !== "string"
  )
    return { reason: "invalid_content" };
  if (Buffer.byteLength(response.content[0].text) > 24 * 1024) return { reason: "output_size" };
  if (error instanceof SyntaxError) return { reason: "invalid_json" };
  if (error instanceof ZodError) {
    const issues = error.issues.slice(0, 16);
    return {
      reason: "invalid_schema",
      codes: [...new Set(issues.map((issue) => issue.code))].join(","),
      paths: [
        ...new Set(
          issues.map(
            (issue) =>
              issue.path
                .map((part) =>
                  typeof part === "number" && Number.isInteger(part) && part >= 0 && part < 64
                    ? String(part)
                    : typeof part === "string" && fields.has(part)
                      ? part
                      : "$",
                )
                .join(".") || "$",
          ),
        ),
      ].join(","),
    };
  }
  return { reason: "invalid_proposal" };
}
