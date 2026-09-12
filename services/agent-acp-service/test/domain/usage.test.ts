import { describe, expect, it } from "vitest";
import { costReceipt, projectUsage, type ModelPricing } from "../../src/domain/usage.js";

const pricing: ModelPricing = {
  currency: "USD",
  inputPerMillion: 2,
  outputPerMillion: 8,
  cacheReadPerMillion: 0.5,
  cacheWritePerMillion: 3,
};
describe("model usage pricing", () => {
  it("does not erase the saved baseline on an unrepresentable total", () => {
    const previous = { amount: Number.MAX_SAFE_INTEGER, currency: "USD" as const };
    const cost = { amount: 1, currency: "USD" as const, source: "provider_reported" as const };
    const overflow = projectUsage({ cost }, 64000, previous);
    expect(overflow.cost).toEqual(previous);
    expect(overflow.measurement?.cost).toEqual(cost);
    expect(projectUsage({ cost }, 64000, overflow.cost).cost).toEqual(previous);
  });
  it("prefers an explicit Provider amount, including zero", () => {
    for (const amount of [0, 0.001]) {
      expect(
        costReceipt({ inputTokens: 100, outputTokens: 20 }, { amount, currency: "USD" }, pricing),
      ).toEqual({ amount, currency: "USD", source: "provider_reported" });
    }
  });
  it("counts cached input once and preserves frozen pricing", () => {
    const result = costReceipt(
      { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 200 },
      undefined,
      pricing,
    );
    expect(result?.amount).toBeCloseTo(0.00255, 12);
    expect(result).toMatchObject({ currency: "USD", source: "estimated", pricing });
    expect(
      costReceipt({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 }, undefined, {
        currency: "USD",
        inputPerMillion: 2,
        outputPerMillion: 8,
      })?.amount,
    ).toBeCloseTo(0.0028, 12);
  });
  it("does not fabricate zero for missing usage/prices or inconsistent counts", () => {
    expect(costReceipt(undefined, undefined, pricing)).toBeUndefined();
    expect(costReceipt({ inputTokens: 100, outputTokens: 20 })).toBeUndefined();
    expect(
      costReceipt({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 101 }, undefined, pricing),
    ).toBeUndefined();
    expect(costReceipt({ inputTokens: -1, outputTokens: 20 }, undefined, pricing)).toBeUndefined();
    expect(
      costReceipt({ inputTokens: 100, outputTokens: 20 }, { amount: -1, currency: "USD" }),
    ).toBeUndefined();
    expect(
      costReceipt({ inputTokens: 100, outputTokens: 20 }, { amount: 3, currency: "EUR" }),
    ).toBeUndefined();
    expect(
      costReceipt({ inputTokens: 100, outputTokens: 20 }, { amount: 3, currency: "EUR" }, pricing)
        ?.source,
    ).toBe("estimated");
  });
  it("supports explicitly free rates and rejects invalid numeric prices", () => {
    expect(
      costReceipt({ inputTokens: 100, outputTokens: 20 }, undefined, {
        currency: "USD",
        inputPerMillion: 0,
        outputPerMillion: 0,
      })?.amount,
    ).toBe(0);
    for (const rate of [-1, NaN, Infinity]) {
      expect(
        costReceipt({ inputTokens: 100, outputTokens: 20 }, undefined, {
          ...pricing,
          inputPerMillion: rate,
        }),
      ).toBeUndefined();
    }
  });
  it("accumulates known cost without repricing or treating unpriced calls as free", () => {
    const first = projectUsage(
      {
        inputTokens: 10,
        outputTokens: 2,
        cost: { amount: 0.03, currency: "USD", source: "provider_reported" },
      },
      64000,
    );
    expect(first.cost).toEqual({ amount: 0.03, currency: "USD" });
    const unknown = projectUsage({ inputTokens: 5, outputTokens: 1 }, 32000, first.cost);
    expect(unknown).toMatchObject({
      used: 6,
      size: 32000,
      cost: first.cost,
      measurement: { inputTokens: 5, outputTokens: 1 },
    });
    const next = projectUsage(
      {
        inputTokens: 2,
        outputTokens: 1,
        cost: { amount: 0.02, currency: "USD", source: "estimated", pricing },
      },
      32000,
      unknown.cost,
    );
    expect(next.cost?.amount).toBeCloseTo(0.05, 12);
    expect(first.cost?.amount).toBe(0.03);
    expect(projectUsage({ inputTokens: 0, outputTokens: 0 }, 32000).cost).toBeUndefined();
  });
});
