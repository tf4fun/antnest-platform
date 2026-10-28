import { describe, expect, it } from "vitest";
import { modelUsage } from "../../src/adapters/model/openai-usage.js";
import { chargeModelUsage } from "../../src/domain/model-budget.js";
import type { ModelPricing, ModelUsage } from "../../src/domain/usage.js";

const pricing: ModelPricing = { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 };

describe("model budget usage provenance", () => {
  it.each([
    { cache_creation_input_tokens: -1 },
    { prompt_tokens_details: { cached_tokens: "5" } },
    { prompt_tokens_details: { cached_tokens: 0.5 } },
    { prompt_cache_hit_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])("does not turn invalid raw cache accounting into known spend: %j", (cache) => {
    const usage = modelUsage({ prompt_tokens: 100, completion_tokens: 1, ...cache }, pricing);
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 1 });
    expect(usage.cost).toBeUndefined();
    expect(chargeModelUsage(usage, pricing)).toBeNull();
  });

  it("requires an accounting receipt instead of inferring completeness from the surviving counters", () => {
    expect(chargeModelUsage({ inputTokens: 100, outputTokens: 1 }, pricing)).toBeNull();
    const trusted = modelUsage({ prompt_tokens: 100, completion_tokens: 1 }, pricing);
    expect(chargeModelUsage(trusted, pricing)).toBe(102n);
    expect(
      chargeModelUsage(
        modelUsage(
          { prompt_tokens: 100, completion_tokens: 1, cache_creation_input_tokens: -1, cost: 0 },
          pricing,
        ),
        pricing,
      ),
    ).toBe(0n);
  });

  it("rejects an invalid estimated receipt even when its frozen pricing matches", () => {
    for (const value of [
      { amount: -1, currency: "USD" },
      { amount: Infinity, currency: "USD" },
      { amount: 1, currency: "EUR" },
      { amount: Number.MAX_SAFE_INTEGER + 1, currency: "USD" },
    ]) {
      const usage = {
        inputTokens: 100,
        outputTokens: 1,
        cost: { ...value, source: "estimated", pricing },
      } as ModelUsage;
      expect(chargeModelUsage(usage, pricing)).toBeNull();
    }
  });
});
