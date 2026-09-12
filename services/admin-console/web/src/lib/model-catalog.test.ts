import assert from "node:assert/strict";
import test from "node:test";
import {
  presetParameters,
  savedParameters,
  validateModelParameters,
  validateModelDisplayName,
  matchModelSelection,
  modelCatalogGate,
  modelProfileLabel,
  modelInputLabel,
} from "./model-catalog.ts";
import type { ModelCatalog, ModelProfile } from "./types.ts";

test("model names use a 200-code-point limit without truncation", () => {
  for (const symbol of ["a", "\u6a21", "\u{1f680}"]) {
    assert.equal(validateModelDisplayName(symbol.repeat(200)), symbol.repeat(200));
    assert.throws(() => validateModelDisplayName(symbol.repeat(201)), /200/);
  }
  assert.throws(() => validateModelDisplayName(" \t\u3000"), /name/);
});

const catalog: ModelCatalog = {
  revision: "2026-09-03",
  providers: [
    {
      provider_key: "deepseek",
      display_name: "DeepSeek",
      description: "Official API",
      base_url: "https://api.deepseek.com",
      custom: false,
      models: [
        {
          model_id: "deepseek-v4-pro",
          display_name: "DeepSeek V4 Pro",
          context_window: 1_000_000,
          max_output_tokens: 384_000,
          supports_images: false,
        },
      ],
    },
    {
      provider_key: "openai-compatible",
      display_name: "Custom API",
      description: "Custom endpoint",
      base_url: "",
      custom: true,
      models: [],
    },
  ],
};

const profile: ModelProfile = {
  provider_connection_id: "connection-1",
  model_profile_id: "model-profile-1",
  display_name: "DeepSeek production",
  revision_id: "model-revision-1",
  revision: 1,
  enabled: true,
  model: {
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    context_window: 1_000_000,
    max_output_tokens: 384_000,
    supports_images: false,
  },
  created_at: "2026-09-03T00:00:00Z",
  updated_at: "2026-09-03T00:00:00Z",
};

test("confirmed metadata wins over defaults and excludes connection parameters", () => {
  const value = validateModelParameters({ ...savedParameters(profile.model), context_window: 2048, max_output_tokens: 32, supports_images: true });
  assert.equal(value.context_window, 2048);
  assert.equal(value.max_output_tokens, 32);
  assert.equal(value.supports_images, true);
  assert.equal("base_url" in value, false);
  assert.equal("credential" in value, false);
});

test("unlisted model parameters are validated without a provider or key", () => {
  const model = { ...savedParameters(profile.model), model: " company-model ", context_window: 96_000, max_output_tokens: 12_000, supports_images: true };
  assert.deepEqual(validateModelParameters(model), { ...model, model: "company-model" });
  for (const invalid of [{ ...model, model: "" }, { ...model, context_window: 0 }, { ...model, max_output_tokens: 0 }, { ...model, context_window: NaN }]) {
    assert.throws(() => validateModelParameters(invalid));
  }
});

test("native input capabilities remain independent", () => {
  for (const audio of [false, true]) for (const pdf of [false, true]) {
    const model = validateModelParameters({ ...savedParameters(profile.model), supports_audio: audio, supports_pdf: pdf });
    assert.equal(model.supports_audio, audio);
    assert.equal(model.supports_pdf, pdf);
    assert.equal(modelInputLabel(model), ["Text", ...(audio ? ["Audio"] : []), ...(pdf ? ["PDF"] : [])].join(", "));
  }
  assert.equal(modelInputLabel({ supports_images: true }), "Text, Images");
});

test("known endpoints match catalogue identity without rewriting stored values", () => {
  assert.deepEqual(matchModelSelection(catalog, { base_url: "https://api.deepseek.com/v1", model: "deepseek-v4-pro" }), { providerKey: "deepseek", modelID: "deepseek-v4-pro" });
  assert.deepEqual(matchModelSelection(catalog, { base_url: "https://models.example.com/v1", model: "private-model" }), { providerKey: "openai-compatible", modelID: "private-model" });
});

test("existing profiles retain a safe label when release catalog metadata is unavailable", () => {
  assert.equal(modelProfileLabel(catalog, profile), "DeepSeek");
  assert.equal(modelProfileLabel(undefined, profile), "DeepSeek production");
});

test("catalog availability gates model changes without gating existing reads", () => {
  assert.equal(modelCatalogGate("loading").changeAllowed, false);
  assert.equal(modelCatalogGate("error").changeAllowed, false);
  assert.deepEqual(modelCatalogGate("ready"), { changeAllowed: true });
});

test("new defaults and saved parameters are distinct sources, including unknown prices", () => {
  const entry = catalog.providers[0]!.models[0]!;
  assert.equal(presetParameters(entry).context_window, 1_000_000);
  const saved = { ...profile.model, context_window: 4096, max_output_tokens: 1024, supports_images: true, temperature: 0.2 };
  const parameters = savedParameters(saved);
  assert.equal(parameters.context_window, 4096);
  assert.equal(parameters.temperature, 0.2);
  assert.equal(parameters.supports_images, true);
  assert.equal("pricing" in parameters, false);
  assert.equal("base_url" in parameters, false);
});

test("unknown models under builtin connections remain editable and price copies are independent", () => {
  const saved = { ...profile.model, model: "new-model", context_window: 4096, pricing: { currency: "USD" as const, input_per_million: 0, output_per_million: 1 } };
  const parameters = savedParameters(saved);
  assert.equal(validateModelParameters(parameters).model, "new-model");
  assert.equal(parameters.context_window, 4096);
  parameters.pricing!.input_per_million = 99;
  assert.equal(saved.pricing.input_per_million, 0);
});
