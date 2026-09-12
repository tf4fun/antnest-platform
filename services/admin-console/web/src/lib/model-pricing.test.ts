import assert from "node:assert/strict";
import test from "node:test";
import { formatModelRate, modelPricingIdentity, parseModelPricing, pricingDraft } from "./model-pricing.ts";
import type { ModelCatalog, ModelPricing } from "./types.ts";

const rates: ModelPricing = { currency: "USD", input_per_million: 0.00001234567,
  output_per_million: 8, cache_read_per_million: 0, cache_write_per_million: 0.5 };

function fields(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

test("pricing omission differs from explicitly free rates and optional caches", () => {
  assert.equal(parseModelPricing(fields()), undefined);
  assert.equal(parseModelPricing(fields({ input_per_million: "-1" })), undefined);
  assert.deepEqual(parseModelPricing(fields({ pricing_enabled: "on", input_per_million: "0", output_per_million: "0" })),
    { currency: "USD", input_per_million: 0, output_per_million: 0 });
  assert.deepEqual(parseModelPricing(fields({ pricing_enabled: "on", input_per_million: "2", output_per_million: "8",
    cache_read_per_million: "0", cache_write_per_million: " " })),
    { currency: "USD", input_per_million: 2, output_per_million: 8, cache_read_per_million: 0 });
});

test("pricing parser rejects incomplete, nondecimal, negative and nonfinite rates", () => {
  for (const name of ["input_per_million", "output_per_million", "cache_read_per_million", "cache_write_per_million"]) {
    for (const value of ["-0.1", "NaN", "Infinity", "1e309", "1e-400", "-1e-400", "free", "0x10", "1,000"]) {
      assert.throws(() => parseModelPricing(fields({ pricing_enabled: "on", input_per_million: "1", output_per_million: "1", [name]: value })));
    }
  }
  for (const name of ["input_per_million", "output_per_million"]) {
    assert.throws(() => parseModelPricing(fields({ pricing_enabled: "on", input_per_million: "1", output_per_million: "1", [name]: " " })));
  }
});

test("pricing retains representable subnormal rates and exponent-form zero", () => {
  assert.deepEqual(parseModelPricing(fields({ pricing_enabled: "on", input_per_million: "5e-324", output_per_million: "0e-400" })),
    { currency: "USD", input_per_million: Number.MIN_VALUE, output_per_million: 0 });
});

test("rate drafts preserve saved precision without mutating catalog data", () => {
  const draft = pricingDraft(rates);
  assert.equal(draft.input_per_million, String(rates.input_per_million));
  assert.equal(draft.cache_read_per_million, "0");
  assert.deepEqual(parseModelPricing(fields({ pricing_enabled: "on", ...draft })), rates);
  assert.deepEqual(pricingDraft(), { input_per_million: "", output_per_million: "", cache_read_per_million: "", cache_write_per_million: "" });
});

test("rate display never rounds tiny paid rates to free or hides unknown", () => {
  assert.equal(formatModelRate(undefined), "Not configured");
  assert.equal(formatModelRate(0), "$0");
  assert.equal(formatModelRate(0.075), "$0.075");
  assert.notEqual(formatModelRate(1e-15), "$0");
  assert.ok(formatModelRate(1e100).length < 30);
});

test("pricing identity recognizes official aliases but not lookalike proxies", () => {
  const catalog: ModelCatalog = { revision: "test", providers: [
    { provider_key: "deepseek", display_name: "DeepSeek", description: "", base_url: "https://api.deepseek.com", custom: false,
      models: [{ model_id: "example", display_name: "Example", context_window: 8192, max_output_tokens: 1024, supports_images: false, pricing: rates }] },
    { provider_key: "custom", display_name: "Custom", description: "", base_url: "", custom: true, models: [] },
  ] };
  const original = modelPricingIdentity(catalog, { base_url: "https://api.deepseek.com", model: "example" });
  assert.equal(modelPricingIdentity(catalog, { base_url: "https://api.deepseek.com/v1/", model: "example" }), original);
  assert.notEqual(modelPricingIdentity(catalog, { base_url: "https://custom.test/v1", model: "example" }), original);
  assert.notEqual(modelPricingIdentity(catalog, { base_url: "https://api.deepseek.com", model: "other" }), original);
});
