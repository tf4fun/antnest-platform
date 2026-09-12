import { z } from "zod";

const rate = z.number().nonnegative();
export const modelPricingSchema = z
  .object({
    currency: z.literal("USD"),
    inputPerMillion: rate,
    outputPerMillion: rate,
    cacheReadPerMillion: rate.optional(),
    cacheWritePerMillion: rate.optional(),
  })
  .strict();
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export type Money = { amount: number; currency: "USD" };
export type CostReceipt = Money &
  (
    | { source: "provider_reported"; pricing?: never }
    | { source: "estimated"; pricing: ModelPricing }
  );
export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};
export type ModelUsage = Partial<TokenCounts> & { cost?: CostReceipt };
export type UsageUpdate = {
  used: number;
  size: number;
  measurement?: ModelUsage;
  cost?: Money;
};

export function costReceipt(
  usage: TokenCounts | undefined,
  reported?: { amount: number; currency: string },
  pricing?: ModelPricing,
): CostReceipt | undefined {
  if (reported?.currency === "USD" && validAmount(reported.amount))
    return { amount: reported.amount, currency: "USD", source: "provider_reported" };
  const rates = modelPricingSchema.safeParse(pricing);
  if (usage === undefined || !rates.success || !validCounts(usage)) return undefined;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const ordinary = usage.inputTokens - read - write;
  if (ordinary < 0) return undefined;
  const price = rates.data;
  const amount =
    (ordinary * price.inputPerMillion +
      usage.outputTokens * price.outputPerMillion +
      read * (price.cacheReadPerMillion ?? price.inputPerMillion) +
      write * (price.cacheWritePerMillion ?? price.inputPerMillion)) /
    1_000_000;
  return validAmount(amount)
    ? { amount, currency: "USD", source: "estimated", pricing: { ...price } }
    : undefined;
}

export function projectUsage(usage: ModelUsage, size: number, previous?: Money): UsageUpdate {
  const amount = (previous?.amount ?? 0) + (usage.cost?.amount ?? 0);
  const known = previous !== undefined || usage.cost !== undefined;
  const cost = known && validAmount(amount) ? { amount, currency: "USD" as const } : previous;
  return {
    used: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    size,
    measurement: structuredClone(usage),
    ...(cost === undefined ? {} : { cost: { ...cost } }),
  };
}

function validAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER;
}

function validCounts(usage: TokenCounts): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}
