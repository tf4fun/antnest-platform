import assert from "node:assert/strict";
import test from "node:test";
import {
  initialModelSelection,
  matchModelSelection,
  modelCatalogGate,
  modelProfileLabel,
  resolveModelSelection,
} from "./model-catalog.ts";
import type { ModelCatalog, ModelProfile } from "./types.ts";

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
  model_profile_id: "model-profile-1",
  profile_key: "deepseek-v4-pro",
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

test("known model selection uses authority metadata and a generated label", () => {
  assert.deepEqual(
    resolveModelSelection(catalog, {
      providerKey: "deepseek",
      modelID: "deepseek-v4-pro",
      baseURL: "https://wrong.example.com",
      contextWindow: 2048,
      maxOutputTokens: 32,
      supportsImages: true,
    }),
    {
      displayName: "DeepSeek · DeepSeek V4 Pro",
      model: {
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        context_window: 1_000_000,
        max_output_tokens: 384_000,
        supports_images: false,
      },
    },
  );
});

test("custom model selection preserves administrator-supplied capabilities", () => {
  assert.deepEqual(
    resolveModelSelection(catalog, {
      providerKey: "openai-compatible",
      modelID: "company-model",
      baseURL: "https://models.example.com/v1/",
      contextWindow: 96_000,
      maxOutputTokens: 12_000,
      supportsImages: true,
    }),
    {
      displayName: "models.example.com · company-model",
      model: {
        base_url: "https://models.example.com/v1",
        model: "company-model",
        context_window: 96_000,
        max_output_tokens: 12_000,
        supports_images: true,
      },
    },
  );
});

test("existing known profiles and new drafts resolve to stable selections", () => {
  assert.deepEqual(initialModelSelection(catalog), {
    providerKey: "deepseek",
    modelID: "deepseek-v4-pro",
  });
  assert.deepEqual(
    matchModelSelection(catalog, {
      base_url: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
      context_window: 1,
      max_output_tokens: 1,
      supports_images: true,
    }),
    { providerKey: "deepseek", modelID: "deepseek-v4-pro" },
  );
  assert.deepEqual(
    matchModelSelection(catalog, {
      base_url: "https://models.example.com/v1",
      model: "private-model",
      context_window: 64_000,
      max_output_tokens: 8_000,
      supports_images: false,
    }),
    { providerKey: "openai-compatible", modelID: "private-model" },
  );
});

test("existing profiles retain a safe label when release catalog metadata is unavailable", () => {
  assert.equal(modelProfileLabel(catalog, profile), "DeepSeek");
  assert.equal(modelProfileLabel(undefined, profile), "DeepSeek production");
});

test("catalog availability gates model changes without gating existing reads", () => {
  assert.deepEqual(modelCatalogGate("loading"), {
    changeAllowed: false,
    message: "Loading model catalog.",
  });
  assert.deepEqual(modelCatalogGate("error"), {
    changeAllowed: false,
    message: "Model catalog is unavailable. Retry before changing model configuration.",
  });
  assert.deepEqual(modelCatalogGate("ready"), { changeAllowed: true });
});
