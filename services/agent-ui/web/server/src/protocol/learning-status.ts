import { z } from "zod";
const id = z.string().min(1).max(200);
export const learningStatusSchema = z.strictObject({
  agentId: id,
  blocked: z.strictObject({
    reason: z.enum(["writer_present", "unknown_effect", "model_unavailable", "runtime_unavailable", "review_inconclusive"]),
    skillName: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
    sourceSessionId: id.optional(),
    sourceRunId: id.optional(),
  }).nullable(),
});
export type LearningStatus = z.infer<typeof learningStatusSchema>;
