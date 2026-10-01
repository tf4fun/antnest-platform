import { z } from "zod";
import type { learningSkillTextPackage } from "./learning-candidate-package.js";

const org = z.string().regex(/^org_[0-9a-f]{32}$/u);
const agent = z.string().regex(/^agent_[0-9a-f]{32}$/u);
const user = z.string().regex(/^user_[0-9a-f]{32}$/u);
const name = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const description = z
  .string()
  .refine(
    (v) => v === v.trim() && v.length > 0 && Buffer.byteLength(v) <= 512 && !v.includes("\0"),
  );

export const skillProjectionSchema = z.strictObject({
  organization_id: org,
  agent_id: agent,
  owner_id: user,
  name,
  description,
  sequence,
  content_digest: digest,
  active: z.boolean(),
});
export type SkillProjection = z.infer<typeof skillProjectionSchema>;
export const skillSourceKeySchema = z.strictObject({ agent_id: agent, name });
export type SkillSourceKey = z.infer<typeof skillSourceKeySchema>;
export const skillSourceInspectSchema = z.strictObject({
  organization_id: org,
  actor_id: user,
  sources: z
    .array(skillSourceKeySchema)
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((s) => `${s.agent_id}/${s.name}`)).size === items.length),
});
export type SkillSourceInspect = z.infer<typeof skillSourceInspectSchema>;
export const skillSourceArtifactSchema = z.strictObject({
  organization_id: org,
  actor_id: user,
  skill_ref: skillSourceKeySchema.extend({ kind: z.literal("agent"), sequence }),
  expected_digest: digest,
});
export type SkillSourceArtifact = z.infer<typeof skillSourceArtifactSchema>;
export type SkillSourceRecord = {
  projection: SkillProjection;
  packagePath: string;
  candidateId: string;
  taskId: string;
  generation: number;
  effectRequestId: string;
  package: ReturnType<typeof learningSkillTextPackage>;
};
export class SkillSourceError extends Error {
  public constructor(public readonly code: "not_found" | "content_changed" | "source_unavailable") {
    super(
      code === "not_found"
        ? "Skill source not found"
        : code === "content_changed"
          ? "Skill source content changed"
          : "Skill source unavailable",
    );
  }
}
