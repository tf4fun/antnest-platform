import { ERROR_METADATA } from "../errors.gen.js";
import { z } from "zod";
import type { ToolEffectState } from "./types.js";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const reply = {
  request_id: id,
  job_id: id,
  execution_id: z.string().min(1).max(200),
  effect_state: z.literal("settled"),
  runtime_call_stopped: z.literal(true),
};
export const temporaryInstalledSchema = z.strictObject({
  ...reply,
  action: z.literal("temporary_install"),
  outcome: z.literal("installed"),
  temporary_path: z
    .string()
    .regex(/^\/workspace\/\.antnest\/skill-temporary\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\/package$/u),
  content_digest: digest,
  artifact_digest: digest,
  unpacked_size: z.number().int().min(1).max(33554432),
});
export const temporaryReleasedSchema = z.strictObject({
  ...reply,
  action: z.literal("temporary_release"),
  outcome: z.literal("released"),
});
const temporaryLegacyError = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "unknown_action",
      "temporary_disabled",
      "temporary_unauthorized",
      "invalid_request",
      "request_conflict",
      "limit_exceeded",
      "body_too_large",
      "body_timed_out",
      "run_closed",
      "temporary_scope_busy",
      "runtime_busy",
      "outcome_unknown",
      "temporary_unavailable",
      "clock_unavailable",
    ]),
    message: z.literal("Temporary Skill request did not complete"),
    retryable: z.boolean(),
    effect_state: z.enum(["none", "settled", "unknown"]),
    runtime_call_stopped: z.boolean(),
  }),
});
const temporaryCommonEnvelope = z.strictObject({
  code: temporaryLegacyError.shape.error.shape.code,
  category: z.enum([
    "invalid_request",
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "precondition_failed",
    "rate_limited",
    "unavailable",
    "internal",
  ]),
  message: z.literal("Temporary Skill request did not complete"),
  retryable: z.boolean(),
  request_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
});
const temporaryCommonError = z
  .strictObject({
    code: temporaryCommonEnvelope.shape.code,
    category: temporaryCommonEnvelope.shape.category,
    message: temporaryCommonEnvelope.shape.message,
    retryable: temporaryCommonEnvelope.shape.retryable,
    request_id: temporaryCommonEnvelope.shape.request_id,
    details: z
      .strictObject({
        effect_state: z.enum(["none", "settled", "unknown"]),
        runtime_call_stopped: z.boolean(),
      })
      .optional(),
    error: temporaryCommonEnvelope.extend({
      effect_state: z.enum(["none", "settled", "unknown"]),
      runtime_call_stopped: z.boolean(),
    }),
  })
  .superRefine((value, issue) => {
    const meta = Object.hasOwn(ERROR_METADATA, value.code)
      ? ERROR_METADATA[value.code as keyof typeof ERROR_METADATA]
      : undefined;
    if (meta === undefined || meta.category !== value.category) {
      issue.addIssue({
        code: "custom",
        message: "category does not match the registered code",
        path: ["category"],
      });
      return;
    }
    const nested = value.error;
    if (
      nested.code !== value.code ||
      nested.retryable !== value.retryable ||
      nested.request_id !== value.request_id ||
      nested.category !== value.category
    ) {
      issue.addIssue({
        code: "custom",
        message: "nested alias must equal the top envelope",
        path: ["error"],
      });
      return;
    }
    if (
      value.details !== undefined &&
      (value.details.effect_state !== nested.effect_state ||
        value.details.runtime_call_stopped !== nested.runtime_call_stopped)
    ) {
      issue.addIssue({
        code: "custom",
        message: "details must duplicate the nested effect fields",
        path: ["details"],
      });
    }
  });
export const temporaryErrorSchema = z.union([temporaryLegacyError, temporaryCommonError]);

export class TemporarySkillFailure extends Error {
  public readonly code: "temporary_unavailable" | "temporary_limit_exceeded" | "content_changed";
  public constructor(
    public readonly effectState: ToolEffectState,
    public readonly runtimeCallStopped: boolean,
    public readonly remoteCode?: string,
  ) {
    const code =
      remoteCode === "limit_exceeded"
        ? "temporary_limit_exceeded"
        : remoteCode === "request_conflict"
          ? "content_changed"
          : "temporary_unavailable";
    super(
      code === "temporary_limit_exceeded"
        ? "This Run has reached its temporary Skill quota."
        : code === "content_changed"
          ? "Temporary Skill content changed; do not reuse its path."
          : "Temporary Skill delivery is unavailable.",
    );
    this.code = code;
  }
}
