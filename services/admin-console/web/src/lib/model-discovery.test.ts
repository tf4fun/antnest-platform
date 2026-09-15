import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichDiscoveredModels } from "./model-discovery.ts";

test("discovery merges builtin and remote IDs, preserves remote metadata and unknown prices", () => {
  const presets = [
    {
      model_id: "known",
      display_name: "Known",
      context_window: 128000,
      max_output_tokens: 8192,
      supports_images: true,
    },
  ];
  const models = enrichDiscoveredModels(
    [
      {
        model_id: "known",
        display_name: "Live",
        supports_images: false,
        context_window: 64000,
      },
      { model_id: "unknown", display_name: "Unknown" },
      { model_id: "known", display_name: "Duplicate" },
    ],
    presets,
  );
  assert.equal(models.length, 2);
  assert.equal(models[0]?.context_window, 64000);
  assert.equal(models[0]?.max_output_tokens, 8192);
  assert.equal(models[0]?.supports_images, false);
  assert.equal(models[1]?.context_window, 0);
  assert.equal(models[1]?.pricing, undefined);
  assert.deepEqual(enrichDiscoveredModels([], presets), presets);
});

test("saved models win over discovery and remain visible when absent remotely", () => {
  const saved = [
    {
      model_id: "saved",
      display_name: "Administrator name",
      context_window: 32000,
      max_output_tokens: 4000,
      supports_images: false,
    },
    {
      model_id: "retained",
      display_name: "Retained",
      context_window: 8000,
      max_output_tokens: 1000,
      supports_images: false,
    },
  ];
  const merged = enrichDiscoveredModels(
    [{ model_id: "saved", display_name: "Remote name", context_window: 64000 }],
    [],
    saved,
  );
  assert.deepEqual(merged, saved);
});
