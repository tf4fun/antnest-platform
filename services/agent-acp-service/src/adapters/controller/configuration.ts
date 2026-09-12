import { z } from "zod";
import {
  authorizationModeSchema,
  type SessionConfiguration,
} from "../../domain/session-configuration.js";

const rule = z
  .object({
    source: z.enum(["runtime", "agent"]),
    source_id: z.string().min(1),
    tool_name: z.string().min(1),
    decision: z.enum(["allow", "deny"]),
  })
  .strict()
  .transform((value) => ({
    source: value.source,
    sourceId: value.source_id,
    toolName: value.tool_name,
    decision: value.decision,
  }));
const authorization = z
  .object({ mode: authorizationModeSchema, tool_rules: z.array(rule).max(256) })
  .strict()
  .transform((value) => ({ mode: value.mode, toolRules: value.tool_rules }));
const modelShape = {
  model_profile_id: z.string().min(1),
  revision_id: z.string().min(1),
  display_name: z.string().min(1),
  model: z.string().min(1),
  context_window: z.number().int().min(1024),
  max_output_tokens: z.number().int().positive(),
  supports_images: z.boolean(),
};
function model(value: z.infer<z.ZodObject<typeof modelShape>>) {
  return {
    modelProfileId: value.model_profile_id,
    revisionId: value.revision_id,
    displayName: value.display_name,
    model: value.model,
    contextWindow: value.context_window,
    maxOutputTokens: value.max_output_tokens,
    supportsImages: value.supports_images,
  };
}
export const catalogSchema = z
  .object({
    models: z.array(z.object(modelShape).strict().transform(model)),
    next_cursor: z.string(),
    default_model: z
      .object({ ...modelShape, available: z.boolean() })
      .strict()
      .transform((value) => ({ ...model(value), available: value.available })),
    default_authorization: authorization,
    authorization_revision: z.number().int().positive(),
  })
  .strict()
  .transform((value) => ({
    models: value.models,
    nextCursor: value.next_cursor,
    defaultModel: value.default_model,
    defaultAuthorization: value.default_authorization,
    authorizationRevision: value.authorization_revision,
  }));
export const configurationSchema = z
  .object({
    model_profile_id: z.string().min(1),
    model_profile_revision_id: z.string().min(1),
    authorization,
    authorization_revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .transform((value) => ({
    modelProfileId: value.model_profile_id,
    modelProfileRevisionId: value.model_profile_revision_id,
    authorization: value.authorization,
    authorizationRevision: value.authorization_revision,
    digest: value.digest,
  }));

export function encodeConfiguration(value: SessionConfiguration) {
  return {
    ...(value.modelProfileId === undefined ? {} : { model_profile_id: value.modelProfileId }),
    ...(value.authorizationMode === undefined
      ? {}
      : { authorization_mode: value.authorizationMode }),
    ...(value.toolRules === undefined
      ? {}
      : {
          tool_rules: value.toolRules.map((rule) => ({
            source: rule.source,
            source_id: rule.sourceId,
            tool_name: rule.toolName,
            decision: rule.decision,
          })),
        }),
  };
}
