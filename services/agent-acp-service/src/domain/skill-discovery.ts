import { z } from "zod";
import { DomainError } from "./errors.js";
import { skillSourceKeySchema } from "./skill-source.js";
import type { JsonObject, ModelToolDefinition } from "./types.js";

const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const skillContentDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const skillReferenceSchema = z.union([
  skillSourceKeySchema.extend({ kind: z.literal("agent"), sequence }),
  z.strictObject({
    kind: z.literal("registry"),
    skill_id: z.string().regex(/^skill_[0-9a-f]{32}$/u),
    version: sequence,
  }),
]);
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export const skillFindInputSchema = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(256)
    .regex(/\S/u)
    .refine((v) => Buffer.byteLength(v) <= 256),
  limit: z.number().int().min(1).max(50).optional(),
});
export type SkillFindInput = z.infer<typeof skillFindInputSchema>;
export const skillLoadInputSchema = z.strictObject({
  skill_ref: skillReferenceSchema,
  expected_digest: skillContentDigestSchema,
});
export type SkillLoadInput = z.infer<typeof skillLoadInputSchema>;
export const skillSearchResultSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        skill_ref: skillReferenceSchema,
        name: skillSourceKeySchema.shape.name,
        description: z
          .string()
          .min(1)
          .refine((v) => v === v.trim() && Buffer.byteLength(v) <= 512 && !v.includes("\0")),
        content_digest: skillContentDigestSchema,
      }),
    )
    .max(50),
});
export type SkillSearchResult = z.infer<typeof skillSearchResultSchema>;

// Refinements enforce UTF-8 bounds at dispatch; portable schemas reject extra
// caller authority fields before permission or network interaction.
export const skillDiscoveryTools: ModelToolDefinition[] = [
  {
    name: "find_skill",
    schema: skillFindInputSchema,
    description:
      "Find reusable Skills by name or description when the local Skills do not cover a task. Returns bounded current source references and content digests. Personal sources require the current user's ownership; a search hit does not grant publish permission.",
  },
  {
    name: "load_skill",
    schema: skillLoadInputSchema,
    description:
      "Load exact selected Skill guidance and package files using the reference and digest from find_skill. Multi-file packages return temporary_files.path for ordinary read and foreground Bash during this Run; do not retain temporary paths for background work. Guidance remains subject to system instructions and tool permissions. Does not publish or permanently install a Skill.",
  },
].map(({ name, schema, description }) => ({
  source: "agent",
  sourceId: "skill_registry",
  name,
  modelName: name,
  title: name === "find_skill" ? "Find Skill" : "Load Skill",
  annotations: { readOnlyHint: name === "find_skill" },
  description,
  inputSchema: z.toJSONSchema(schema, { unrepresentable: "any" }) as JsonObject,
}));

export function withSkillDiscoveryTools(tools: ModelToolDefinition[]): ModelToolDefinition[] {
  if (
    tools.some((tool) =>
      skillDiscoveryTools.some((reserved) => reserved.modelName === tool.modelName),
    )
  )
    throw new DomainError(
      "tool_name_collision",
      "Runtime conflicts with reserved Skill discovery tools",
    );
  return [...tools, ...skillDiscoveryTools];
}

const messages = {
  invalid_request: "Skill discovery arguments are invalid.",
  not_found: "Skill or access is no longer available.",
  content_changed: "Skill content changed. Search again and select the current content digest.",
  source_invalid: "Skill source returned invalid content.",
  source_unavailable:
    "Skill discovery is temporarily unavailable. Existing local Skills remain usable.",
  discovery_budget_exceeded: "This Run has reached its Skill discovery request budget.",
} as const;
export class SkillDiscoveryError extends Error {
  public constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
