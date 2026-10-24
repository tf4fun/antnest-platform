import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { DomainError } from "./errors.js";
import { modelPricingSchema, type ModelPricing, type ModelUsage } from "./usage.js";

const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const runBudgetSchema = z.strictObject({
  max_input_tokens: amount.optional(),
  max_output_tokens: amount.optional(),
  max_cost_usd_micros: amount.optional(),
});
const periodCapsSchema = z
  .strictObject({
    soft_cost_usd_micros: amount.optional(),
    hard_cost_usd_micros: amount.optional(),
  })
  .refine(
    (value) =>
      value.soft_cost_usd_micros === undefined ||
      value.hard_cost_usd_micros === undefined ||
      value.soft_cost_usd_micros <= value.hard_cost_usd_micros,
    "Soft budget exceeds hard budget",
  );
export const organizationBudgetSchema = z.strictObject({
  revision: amount,
  unknown_cost: z.enum(["allow", "deny"]),
  run_caps: runBudgetSchema,
  daily: periodCapsSchema,
  monthly: periodCapsSchema,
});
export type RunBudget = z.infer<typeof runBudgetSchema>;
export type OrganizationBudget = z.infer<typeof organizationBudgetSchema>;
export type ModelReservation = Readonly<{ inputTokens?: number; outputTokens?: number }>;

export class ModelBudgetExceededError extends DomainError {
  public constructor(
    public readonly scope:
      | "run_input"
      | "run_output"
      | "run_cost"
      | "organization_daily"
      | "organization_monthly"
      | "unknown_cost",
    public readonly limit: string | null,
    public readonly used: string | null,
  ) {
    super("budget_exceeded", "Model budget does not permit another call");
  }
}

export const legacyOrganizationBudget: OrganizationBudget = Object.freeze({
  revision: 0,
  unknown_cost: "allow",
  run_caps: Object.freeze({}),
  daily: Object.freeze({}),
  monthly: Object.freeze({}),
});

export function knownTokenCount(value: number | undefined): bigint | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

/** Prices are USD per million tokens, numerically equal to microdollars per token. */
export function priceTokenReservation(
  bounds: ModelReservation,
  pricing: ModelPricing | undefined,
): bigint | null {
  const input = knownTokenCount(bounds.inputTokens);
  const output = knownTokenCount(bounds.outputTokens);
  const parsed = modelPricingSchema.safeParse(pricing);
  if (input === null || output === null || !parsed.success) return null;
  const price = parsed.data;
  return roundedSum([
    [
      input,
      Math.max(
        price.inputPerMillion,
        price.cacheReadPerMillion ?? 0,
        price.cacheWritePerMillion ?? 0,
      ),
    ],
    [output, price.outputPerMillion],
  ]);
}

export function chargeModelUsage(
  usage: ModelUsage,
  pricing: ModelPricing | undefined,
): bigint | null {
  // A missing receipt can mean malformed provider cache accounting. Surviving
  // token counters do not prove that the adapter measured a complete cost.
  const receipt = usage.cost;
  if (receipt === undefined || !validUsdReceipt(receipt)) return null;
  if (receipt.source === "provider_reported") return roundedSum([[1_000_000n, receipt.amount]]);
  const parsed = modelPricingSchema.safeParse(pricing);
  if (!parsed.success || !isDeepStrictEqual(receipt.pricing, parsed.data)) return null;
  const input = knownTokenCount(usage.inputTokens);
  const output = knownTokenCount(usage.outputTokens);
  const read = knownTokenCount(usage.cacheReadTokens ?? 0);
  const write = knownTokenCount(usage.cacheWriteTokens ?? 0);
  if (input === null || output === null || read === null || write === null || read + write > input)
    return null;
  const price = parsed.data;
  return roundedSum([
    [input - read - write, price.inputPerMillion],
    [output, price.outputPerMillion],
    [read, price.cacheReadPerMillion ?? price.inputPerMillion],
    [write, price.cacheWritePerMillion ?? price.inputPerMillion],
  ]);
}

function validUsdReceipt(receipt: { amount: number; currency: string; source: string }): boolean {
  return (
    receipt.currency === "USD" &&
    Number.isFinite(receipt.amount) &&
    receipt.amount >= 0 &&
    receipt.amount <= Number.MAX_SAFE_INTEGER &&
    (receipt.source === "provider_reported" || receipt.source === "estimated")
  );
}

// Convert the accepted JSON decimal spelling before arithmetic. No accumulated
// binary floating point amount enters the ledger, including estimated receipts.
function decimal(value: number): { coefficient: bigint; scale: number } {
  const [mantissa = "0", exponent = "0"] = value.toString().toLowerCase().split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  const coefficient = BigInt(whole + fraction);
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function roundedSum(terms: readonly (readonly [bigint, number])[]): bigint {
  const values = terms.map(([count, rate]) => {
    const value = decimal(rate);
    return { ...value, coefficient: value.coefficient * count };
  });
  const scale = Math.max(0, ...values.map((value) => value.scale));
  const denominator = 10n ** BigInt(scale);
  const numerator = values.reduce(
    (sum, value) => sum + value.coefficient * 10n ** BigInt(scale - value.scale),
    0n,
  );
  return (numerator + denominator - 1n) / denominator;
}
