import { z } from "zod";
import { providerTokenLimitsSchema } from "./provider-token-limits.js";
import { runtimeConnectionIdSchema } from "./runtime-connection.js";

import { thinkingEffortSchema } from "./model-thinking.js";
import { admittedConfigurationSchema } from "./session-configuration.js";
import type { ModelSpec, RunExecutionSnapshot } from "./types.js";
import { modelPricingSchema } from "./usage.js";
import { modelFailoverSchema, modelRetrySchema } from "./model-call-policy.js";
import { runBudgetSchema } from "./model-budget.js";

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const modelSchema = z.strictObject({
  providerTokenLimits: providerTokenLimitsSchema.optional(),
  baseUrl: z.url(),
  model: id,
  contextWindow: positive,
  maxOutputTokens: positive,
  temperature: z.number().min(0).max(2).optional(),
  thinking: z
    .strictObject({ protocol: z.literal("deepseek"), effort: thinkingEffortSchema })
    .optional(),
  supportsImages: z.boolean(),
  supportsAudio: z.boolean().optional(),
  supportsPdf: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  tokenizer: z.enum(["o200k", "cl100k", "none"]).optional(),
  compactionModelProfileId: id.optional(),
  pricing: modelPricingSchema.optional(),
});

const schema = z
  .strictObject({
    organizationId: id,
    providerConnectionId: id,
    modelProfileId: id,
    modelProfileRevision: positive.optional(),
    configurationRevision: positive,
    accessRevision: id,
    deadlineAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    agentSpecRevision: id,
    executionRevision: id,
    runtimeMcpSourceDigest: digest,
    agentExecutionSpecDigest: digest,
    runtime: z.strictObject({
      revision: id,
      executionId: id,
      mcpEndpoint: z.url(),
      connectionId: runtimeConnectionIdSchema,
    }),
    executionSpec: z.strictObject({
      configuration: admittedConfigurationSchema.optional(),
      systemPrompt: z.string(),
      contextPolicyVersion: z.literal("context-v1"),
      skillInstructions: z
        .array(z.strictObject({ skillKey: id, version: id, instructions: z.string() }))
        .max(0),
      model: modelSchema,
      maxModelRequests: positive,
      modelRetry: modelRetrySchema.optional(),
      runBudget: runBudgetSchema.optional(),
      modelFailover: modelFailoverSchema.optional(),
      fallbackModels: z
        .array(
          z.strictObject({
            modelProfileId: id,
            providerConnectionId: id,
            modelProfileRevision: positive.optional(),
            model: modelSchema,
          }),
        )
        .max(31)
        .optional(),
      compactionModel: z
        .strictObject({
          modelProfileId: id,
          providerConnectionId: id,
          modelProfileRevision: positive.optional(),
          model: modelSchema,
        })
        .optional(),
    }),
    clientMcpRevisionId: id,
  })
  .superRefine((snapshot, ctx) => {
    const spec = snapshot.executionSpec;
    if ((spec.modelFailover === undefined) !== (spec.fallbackModels === undefined))
      ctx.addIssue({
        code: "custom",
        message: "Incomplete frozen model fallback plan",
        path: ["executionSpec"],
      });
    const profiles = new Set([snapshot.modelProfileId]);
    for (const candidate of spec.fallbackModels ?? []) {
      if (profiles.has(candidate.modelProfileId))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate frozen model candidate",
          path: ["executionSpec", "fallbackModels"],
        });
      profiles.add(candidate.modelProfileId);
      if (
        candidate.model.thinking?.protocol !== spec.model.thinking?.protocol ||
        candidate.model.thinking?.effort !== spec.model.thinking?.effort
      )
        ctx.addIssue({
          code: "custom",
          message: "Fallback changes the original thinking effort",
          path: ["executionSpec", "fallbackModels"],
        });
    }
  });

export function parseStoredRunSnapshot(value: unknown): RunExecutionSnapshot {
  const parsed = schema.parse(value);
  const {
    configuration,
    modelRetry,
    runBudget,
    modelFailover,
    fallbackModels,
    compactionModel,
    ...executionSpec
  } = parsed.executionSpec;
  const { modelProfileRevision, ...rest } = parsed;
  return {
    ...rest,
    ...(modelProfileRevision === undefined ? {} : { modelProfileRevision }),
    executionSpec: {
      ...executionSpec,
      model: normalizedModel(executionSpec.model),
      ...(configuration === undefined ? {} : { configuration }),
      ...(modelRetry === undefined ? {} : { modelRetry }),
      ...(runBudget === undefined ? {} : { runBudget }),
      ...(modelFailover === undefined ? {} : { modelFailover }),
      ...(fallbackModels === undefined
        ? {}
        : {
            fallbackModels: fallbackModels.map((candidate) => ({
              modelProfileId: candidate.modelProfileId,
              providerConnectionId: candidate.providerConnectionId,
              ...(candidate.modelProfileRevision === undefined
                ? {}
                : { modelProfileRevision: candidate.modelProfileRevision }),
              model: normalizedModel(candidate.model),
            })),
          }),
      ...(compactionModel === undefined
        ? {}
        : {
            compactionModel: {
              modelProfileId: compactionModel.modelProfileId,
              providerConnectionId: compactionModel.providerConnectionId,
              ...(compactionModel.modelProfileRevision === undefined
                ? {}
                : { modelProfileRevision: compactionModel.modelProfileRevision }),
              model: normalizedModel(compactionModel.model),
            },
          }),
    },
  };
}

function normalizedModel(value: z.infer<typeof modelSchema>): ModelSpec {
  const {
    temperature,
    thinking,
    supportsAudio,
    supportsPdf,
    supportsTools,
    tokenizer,
    compactionModelProfileId,
    pricing,
    providerTokenLimits,
    ...model
  } = value;
  const normalizedPricing =
    pricing === undefined
      ? undefined
      : {
          currency: pricing.currency,
          inputPerMillion: pricing.inputPerMillion,
          outputPerMillion: pricing.outputPerMillion,
          ...(pricing.cacheReadPerMillion === undefined
            ? {}
            : { cacheReadPerMillion: pricing.cacheReadPerMillion }),
          ...(pricing.cacheWritePerMillion === undefined
            ? {}
            : { cacheWritePerMillion: pricing.cacheWritePerMillion }),
        };
  return {
    ...model,
    ...(temperature === undefined ? {} : { temperature }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(supportsAudio === undefined ? {} : { supportsAudio }),
    ...(supportsPdf === undefined ? {} : { supportsPdf }),
    ...(supportsTools === undefined ? {} : { supportsTools }),
    ...(tokenizer === undefined ? {} : { tokenizer }),
    ...(compactionModelProfileId === undefined ? {} : { compactionModelProfileId }),
    ...(normalizedPricing === undefined ? {} : { pricing: normalizedPricing }),
    ...(providerTokenLimits === undefined ? {} : { providerTokenLimits }),
  };
}
