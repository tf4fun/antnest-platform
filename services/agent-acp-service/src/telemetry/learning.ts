import { context, SpanStatusCode, trace } from "@opentelemetry/api";
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
    "antnest.organization.id": claim.organizationId,
    "antnest.agent.id": claim.agentId,
    "antnest.learning.source_run.id": claim.sourceRunId,
    "antnest.learning.task.id": claim.taskId,
    "antnest.learning.generation": claim.generation,
    "antnest.learning.review_prompt_version": claim.reviewPromptVersion ?? 1,
    "antnest.learning.debug": claim.reviewPromptVersion === 2,
  };
}

function attributes(value: TelemetryAttributes): void {
  trace
    .getSpan(context.active())
    ?.setAttributes(
      Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
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
        "antnest.learning.outcome": result.kind,
        "antnest.learning.pause_reason": result.kind === "paused" ? result.reason : undefined,
        "antnest.learning.change.id": result.kind === "applied" ? result.changeId : undefined,
      });
      if (
        result.kind === "failed" ||
        (result.kind === "paused" && result.reason === "review_inconclusive")
      )
        trace.getSpan(context.active())?.setStatus({ code: SpanStatusCode.ERROR });
      this.telemetry.count("antnest.acp.skill_learning.tasks", {
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
      attributes({ "antnest.learning.apply.outcome": result.kind });
      return result;
    });
  }
}

export class LearningTelemetry implements LearningReviewDiagnostics {
  public constructor(private readonly telemetry: TelemetryPort) {}

  public evidence(claim: LearningTaskClaim, evidence: LearningEvidence): void {
    attributes({
      ...identity(claim),
      "antnest.learning.evidence.truncated": evidence.truncated,
      "antnest.learning.evidence.items": evidence.items.length,
      "antnest.learning.evidence.user_items": evidence.items.filter(
        (item) => item.kind === "authenticated_user",
      ).length,
      "antnest.learning.evidence.execution_items": evidence.items.filter(
        (item) => item.kind === "observed_execution",
      ).length,
      "antnest.learning.evidence.untrusted_items": evidence.items.filter(
        (item) => item.kind === "untrusted_material",
      ).length,
      "antnest.learning.evidence.content_bytes": evidence.items.reduce(
        (total, item) => total + Buffer.byteLength(item.text),
        0,
      ),
    });
  }

  public review(claim: LearningTaskClaim, operation: () => Promise<LearningReviewDecision | null>) {
    return this.telemetry.span("skill_learning.review", identity(claim), async () => {
      const decision = await operation();
      attributes({ "antnest.learning.review.decision": decision?.decision ?? "inconclusive" });
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
        "antnest.learning.call_index": callIndex,
        "antnest.request.id": requestId,
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
        "antnest.learning.call_index": callIndex,
        ...responseAttributes(response),
      },
      async () => {
        try {
          const decision = await Promise.resolve().then(operation);
          attributes({ "antnest.learning.validation.result": "accepted" });
          return decision;
        } catch (error) {
          const failure = validationFailure(response, error);
          attributes({
            "antnest.learning.validation.result": "rejected",
            "antnest.learning.validation.reason": failure.reason,
            "antnest.learning.validation.paths": failure.paths,
            "antnest.learning.validation.codes": failure.codes,
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
    "antnest.model.result.kind": response.kind,
    "antnest.model.stop_reason": response.kind === "message" ? response.stopReason : "tool_calls",
    "antnest.model.content_bytes": byteCount(response.content),
    "antnest.model.thought_bytes": byteCount(response.thought ?? []),
    "antnest.model.markdown_fence": response.content.some(
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
