import { z } from "zod";
import { costReceipt, type ModelPricing, type ModelUsage } from "../../domain/usage.js";

const openAIUsageSchema = z.object({
  prompt_tokens: z.unknown().optional(),
  completion_tokens: z.unknown().optional(),
  prompt_tokens_details: z.unknown().optional(),
  prompt_cache_hit_tokens: z.unknown().optional(),
  cache_read_input_tokens: z.unknown().optional(),
  cache_creation_input_tokens: z.unknown().optional(),
  cost: z.unknown().optional(),
  cost_currency: z.unknown().optional(),
  currency: z.unknown().optional(),
});
type RawUsage = z.infer<typeof openAIUsageSchema>;
const usageEnvelope = z.object({ usage: openAIUsageSchema.nullish() });
const cacheDetails = z.object({ cached_tokens: z.unknown().optional() });

export function extractUsage(payload: unknown): RawUsage | undefined {
  const parsed = usageEnvelope.safeParse(payload);
  return parsed.success ? (parsed.data.usage ?? undefined) : undefined;
}

export function mergeUsage(previous: RawUsage | null | undefined, next: RawUsage): RawUsage {
  const before = cacheDetails.safeParse(previous?.prompt_tokens_details);
  const after = cacheDetails.safeParse(next.prompt_tokens_details);
  return {
    ...previous,
    ...next,
    prompt_tokens_details:
      before.success && after.success
        ? { ...before.data, ...after.data }
        : (next.prompt_tokens_details ?? previous?.prompt_tokens_details),
  };
}

export function modelUsage(raw: RawUsage | undefined, pricing?: ModelPricing): ModelUsage {
  if (raw === undefined) return {};
  const details = cacheDetails.safeParse(raw.prompt_tokens_details ?? {});
  const read = details.success
    ? (details.data.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens)
    : null;
  const write = raw.cache_creation_input_tokens;
  const cacheReadTokens = tokenCount(read);
  const cacheWriteTokens = tokenCount(write);
  const inputTokens = tokenCount(raw.prompt_tokens);
  const outputTokens = tokenCount(raw.completion_tokens);
  const counts: ModelUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
  const measured =
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    (read === undefined || cacheReadTokens !== undefined) &&
    (write === undefined || cacheWriteTokens !== undefined)
      ? { ...counts, inputTokens, outputTokens }
      : undefined;
  const cost = costReceipt(measured, reportedCost(raw), pricing);
  return { ...counts, ...(cost === undefined ? {} : { cost }) };
}

function reportedCost(raw: RawUsage): { amount: number; currency: string } | undefined {
  if (typeof raw.cost !== "number") return undefined;
  const declared = raw.cost_currency ?? raw.currency ?? "USD";
  return {
    amount: raw.cost,
    currency: typeof declared === "string" ? declared.trim().toUpperCase() : "",
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
