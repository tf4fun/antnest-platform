import { z } from "zod";
import { runtimeConnectionIdSchema } from "./runtime-connection.js";

import { thinkingEffortSchema } from "./model-thinking.js";
import { admittedConfigurationSchema } from "./session-configuration.js";
import type { RunExecutionSnapshot } from "./types.js";
import { modelPricingSchema } from "./usage.js";

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const modelSchema = z.strictObject({
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
  pricing: modelPricingSchema.optional(),
});

const schema = z.strictObject({
  organizationId: id,
  providerConnectionId: id,
  modelProfileId: id,
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
  }),
  clientMcpRevisionId: id,
});

export function parseStoredRunSnapshot(value: unknown): RunExecutionSnapshot {
  const parsed = schema.parse(value);
  const { configuration, ...executionSpec } = parsed.executionSpec;
  const { temperature, thinking, supportsAudio, supportsPdf, pricing, ...model } =
    executionSpec.model;
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
    ...parsed,
    executionSpec: {
      ...executionSpec,
      model: {
        ...model,
        ...(temperature === undefined ? {} : { temperature }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(supportsAudio === undefined ? {} : { supportsAudio }),
        ...(supportsPdf === undefined ? {} : { supportsPdf }),
        ...(normalizedPricing === undefined ? {} : { pricing: normalizedPricing }),
      },
      ...(configuration === undefined ? {} : { configuration }),
    },
  };
}
