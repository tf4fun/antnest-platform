import { describe, expect, it } from "vitest";
import {
  chargeModelUsage,
  organizationBudgetSchema,
  priceTokenReservation,
  runBudgetSchema,
} from "../../src/domain/model-budget.js";
import type { ModelPricing, ModelUsage } from "../../src/domain/usage.js";

const maximum = Number.MAX_SAFE_INTEGER;
const runFields = ["max_input_tokens", "max_output_tokens", "max_cost_usd_micros"] as const;
const invalidIntegers = [-1, 0.5, maximum + 1, "1", null, NaN, Infinity];
const pricing: ModelPricing = {
  currency: "USD",
  inputPerMillion: 2,
  outputPerMillion: 8,
  cacheReadPerMillion: 0.5,
  cacheWritePerMillion: 3,
};
const free: ModelPricing = { currency: "USD", inputPerMillion: 0, outputPerMillion: 0 };

function estimatedReceipt(usage: ModelUsage, frozen: ModelPricing, amount: number): ModelUsage {
  return {
    ...usage,
    cost: { amount, currency: "USD", source: "estimated", pricing: { ...frozen } },
  };
}

function organization() {
  return {
    revision: 0,
    unknown_cost: "allow" as const,
    run_caps: {},
    daily: {},
    monthly: {},
  };
}

describe("model budget policy schemas", () => {
  it("preserves absent Run limits and explicit zero or maximum safe limits without defaults", () => {
    expect(runBudgetSchema.parse({})).toEqual({});
    for (const value of [0, maximum]) {
      const limits = Object.fromEntries(runFields.map((field) => [field, value]));
      expect(runBudgetSchema.parse(limits)).toEqual(limits);
      expect(
        organizationBudgetSchema.parse({
          revision: value,
          unknown_cost: "deny",
          run_caps: limits,
          daily: { soft_cost_usd_micros: value, hard_cost_usd_micros: value },
          monthly: { soft_cost_usd_micros: value, hard_cost_usd_micros: value },
        }),
      ).toEqual({
        revision: value,
        unknown_cost: "deny",
        run_caps: limits,
        daily: { soft_cost_usd_micros: value, hard_cost_usd_micros: value },
        monthly: { soft_cost_usd_micros: value, hard_cost_usd_micros: value },
      });
    }
    expect(organizationBudgetSchema.parse(organization())).toEqual(organization());
  });

  it.each(invalidIntegers)("rejects invalid integer limits and revisions: %s", (value) => {
    for (const field of runFields) {
      expect(runBudgetSchema.safeParse({ [field]: value }).success).toBe(false);
      expect(
        organizationBudgetSchema.safeParse({ ...organization(), run_caps: { [field]: value } })
          .success,
      ).toBe(false);
    }
    expect(organizationBudgetSchema.safeParse({ ...organization(), revision: value }).success).toBe(
      false,
    );
    for (const period of ["daily", "monthly"])
      for (const field of ["soft_cost_usd_micros", "hard_cost_usd_micros"])
        expect(
          organizationBudgetSchema.safeParse({ ...organization(), [period]: { [field]: value } })
            .success,
        ).toBe(false);
  });

  it.each(["revision", "unknown_cost", "run_caps", "daily", "monthly"])(
    "requires the organization field %s",
    (field) => {
      const value: Record<string, unknown> = organization();
      delete value[field];
      expect(organizationBudgetSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects unknown fields, coercions and invalid nested objects", () => {
    for (const value of [null, [], "{}", { maxInputTokens: 1 }, { extra: 1 }])
      expect(runBudgetSchema.safeParse(value).success).toBe(false);
    for (const value of [
      null,
      [],
      { ...organization(), extra: 1 },
      { ...organization(), unknown_cost: "ignore" },
      { ...organization(), unknown_cost: null },
      { ...organization(), run_caps: null },
      { ...organization(), daily: null },
      { ...organization(), monthly: "{}" },
      { ...organization(), daily: { extra: 1 } },
      { ...organization(), monthly: { hardCostUsdMicros: 1 } },
    ])
      expect(organizationBudgetSchema.safeParse(value).success).toBe(false);
  });

  it.each(["daily", "monthly"])("rejects %s soft caps above hard caps", (period) => {
    expect(
      organizationBudgetSchema.safeParse({
        ...organization(),
        [period]: { soft_cost_usd_micros: 2, hard_cost_usd_micros: 1 },
      }).success,
    ).toBe(false);
    for (const caps of [{ soft_cost_usd_micros: 1 }, { hard_cost_usd_micros: 0 }])
      expect(
        organizationBudgetSchema.safeParse({ ...organization(), [period]: caps }).success,
      ).toBe(true);
  });
});

describe("integer microdollar reservations", () => {
  it("reserves the highest ordinary or cache input rate without adding cached input twice", () => {
    expect(priceTokenReservation({ inputTokens: 100, outputTokens: 50 }, pricing)).toBe(700n);
    expect(
      priceTokenReservation(
        { inputTokens: 100, outputTokens: 50 },
        { ...pricing, cacheReadPerMillion: 5 },
      ),
    ).toBe(900n);
  });

  it("adds exact decimal components before rounding upward once", () => {
    expect(
      priceTokenReservation(
        { inputTokens: 1, outputTokens: 1 },
        { currency: "USD", inputPerMillion: 0.1, outputPerMillion: 0.2 },
      ),
    ).toBe(1n);
    expect(
      priceTokenReservation(
        { inputTokens: 1, outputTokens: 1 },
        { currency: "USD", inputPerMillion: 1.00000001, outputPerMillion: 0.99999999 },
      ),
    ).toBe(2n);
  });

  it("keeps the exact integer above the safe Number range", () => {
    expect(
      priceTokenReservation(
        { inputTokens: maximum, outputTokens: 0 },
        { currency: "USD", inputPerMillion: 1.1, outputPerMillion: 0 },
      ),
    ).toBe(9_907_919_180_215_091n);
  });

  it("distinguishes explicitly free prices from unknown prices even for zero tokens", () => {
    expect(priceTokenReservation({ inputTokens: maximum, outputTokens: maximum }, free)).toBe(0n);
    expect(priceTokenReservation({ inputTokens: 0, outputTokens: 0 }, pricing)).toBe(0n);
    expect(priceTokenReservation({ inputTokens: 0, outputTokens: 0 }, undefined)).toBeNull();
  });

  it.each([-1, 0.5, maximum + 1, NaN, Infinity])("rejects invalid token bounds: %s", (value) => {
    expect(priceTokenReservation({ inputTokens: value, outputTokens: 0 }, pricing)).toBeNull();
    expect(priceTokenReservation({ inputTokens: 0, outputTokens: value }, pricing)).toBeNull();
  });
});

describe("integer microdollar usage settlement", () => {
  it.each([
    { amount: 0, expected: 0n },
    { amount: 0.0000001, expected: 1n },
    { amount: 0.0000010000000001, expected: 2n },
  ])("prioritizes the exact Provider-reported USD amount $amount", ({ amount, expected }) => {
    const usage: ModelUsage = { cost: { amount, currency: "USD", source: "provider_reported" } };
    expect(chargeModelUsage(usage, undefined)).toBe(expected);
    expect(chargeModelUsage({ ...usage, inputTokens: 1000, outputTokens: 100 }, pricing)).toBe(
      expected,
    );
  });

  it("charges uncached and cached subsets once from complete counts and frozen prices", () => {
    const usage: ModelUsage = {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
    };
    expect(chargeModelUsage(estimatedReceipt(usage, pricing, 0.00255), pricing)).toBe(2550n);
    expect(
      chargeModelUsage(
        estimatedReceipt({ inputTokens: 1000, outputTokens: 100 }, pricing, 0.0028),
        pricing,
      ),
    ).toBe(2800n);
    const ordinary: ModelPricing = { currency: "USD", inputPerMillion: 2, outputPerMillion: 8 };
    expect(chargeModelUsage(estimatedReceipt(usage, ordinary, 0.0028), ordinary)).toBe(2800n);
  });

  it("recomputes estimated receipts from matching frozen prices instead of their amount", () => {
    const usage: ModelUsage = {
      inputTokens: 1,
      outputTokens: 1,
      cost: {
        amount: 999,
        currency: "USD",
        source: "estimated",
        pricing: { currency: "USD", inputPerMillion: 0.1, outputPerMillion: 0.2 },
      },
    };
    const frozen: ModelPricing = { currency: "USD", inputPerMillion: 0.1, outputPerMillion: 0.2 };
    expect(chargeModelUsage(usage, frozen)).toBe(1n);
    expect(chargeModelUsage(usage, { ...frozen, inputPerMillion: 0.3 })).toBeNull();
    expect(chargeModelUsage(usage, undefined)).toBeNull();
  });

  it("settles exact decimal boundaries and large token counts without Number rounding", () => {
    const precise: ModelPricing = {
      currency: "USD",
      inputPerMillion: 1.00000001,
      outputPerMillion: 0.99999999,
    };
    expect(
      chargeModelUsage(
        estimatedReceipt({ inputTokens: 1, outputTokens: 1 }, precise, 0.000002),
        precise,
      ),
    ).toBe(2n);
    const large: ModelPricing = { currency: "USD", inputPerMillion: 1.1, outputPerMillion: 0 };
    expect(
      chargeModelUsage(
        estimatedReceipt({ inputTokens: maximum, outputTokens: 0 }, large, 9_907_919_180.215092),
        large,
      ),
    ).toBe(9_907_919_180_215_091n);
  });

  it("retains unknown usage and rejects incomplete or inconsistent token measurements", () => {
    const measurements: ModelUsage[] = [
      {},
      { inputTokens: 1 },
      { outputTokens: 1 },
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 0.5 },
      { inputTokens: maximum + 1, outputTokens: 0 },
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: 101 },
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: 60, cacheWriteTokens: 41 },
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: -1 },
      { inputTokens: 100, outputTokens: 0, cacheWriteTokens: 0.5 },
    ];
    for (const usage of measurements)
      expect(chargeModelUsage(estimatedReceipt(usage, pricing, 0), pricing)).toBeNull();
    expect(chargeModelUsage({ inputTokens: 1, outputTokens: 1 }, undefined)).toBeNull();
    expect(chargeModelUsage({}, free)).toBeNull();
    expect(
      chargeModelUsage(estimatedReceipt({ inputTokens: 0, outputTokens: 0 }, free, 0), free),
    ).toBe(0n);
  });

  it("does not adopt invalid reported amounts or a non-USD currency as known money", () => {
    for (const amount of [-1, NaN, Infinity])
      expect(
        chargeModelUsage(
          { cost: { amount, currency: "USD", source: "provider_reported" } },
          pricing,
        ),
      ).toBeNull();
    const foreign = {
      cost: { amount: 1, currency: "EUR", source: "provider_reported" },
    } as unknown as ModelUsage;
    expect(chargeModelUsage(foreign, pricing)).toBeNull();
  });
});
