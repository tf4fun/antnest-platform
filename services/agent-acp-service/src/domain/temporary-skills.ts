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
export const temporaryErrorSchema = z.strictObject({
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
