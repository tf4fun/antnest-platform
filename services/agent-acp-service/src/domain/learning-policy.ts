import { z } from "zod";
import { agentIdSchema, organizationIdSchema, scopedIdPattern, userIdSchema } from "./ids.js";

export const learningScopedId = scopedIdPattern;
export const learningPolicyRevision = /^[0-9a-f]{64}$/u;
export const learningUtcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

const packagePath = /^\.antnest\/skills\/[a-z0-9]+(-[a-z0-9]+)*$/u;
const boundedPaths = z
  .array(z.string().max(96).regex(packagePath))
  .max(32)
  .refine((paths) => paths.every((path, index) => index === 0 || paths[index - 1]! < path));

export const learningPolicySchema = z.strictObject({
  organization_id: organizationIdSchema,
  agent_id: agentIdSchema,
  owner_principal_id: userIdSchema,
  revision: z.string().regex(learningPolicyRevision),
  activation_cut_at: z
    .string()
    .regex(learningUtcTimestamp)
    .refine((value) => Number.isFinite(Date.parse(value))),
  mode: z.enum(["automatic", "off"]),
  scope: z.strictObject({
    auto_generated_personal: z.boolean(),
    adopted_paths: z.array(z.string().max(96).regex(packagePath)).length(0),
  }),
  pinned_paths: boundedPaths,
  limits: z.strictObject({
    daily_reviews: z.number().int().min(0).max(20),
    daily_model_input_tokens: z.number().int().min(0).max(320000),
    daily_model_output_tokens: z.number().int().min(0).max(80000),
  }),
});

export type LearningPolicy = z.infer<typeof learningPolicySchema>;
