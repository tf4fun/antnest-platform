import assert from "node:assert/strict";
import test from "node:test";

import { savedParameters, validateModelParameters } from "./model-catalog.ts";
import type { ModelParameters, ModelSpec } from "./types.ts";

const base: ModelParameters = {
  model: "meta-model",
  context_window: 8192,
  max_output_tokens: 1024,
  supports_images: false,
};

test("valid tokenizer enums pass through unchanged", () => {
  for (const tokenizer of ["o200k", "cl100k", "none"] as const) {
    assert.equal(
      validateModelParameters({ ...base, tokenizer }).tokenizer,
      tokenizer,
    );
  }
});

test("omitted context metadata invents no defaults", () => {
  const result = validateModelParameters({ ...base });
  assert.equal("tokenizer" in result, false);
  assert.equal("compaction_model_profile_id" in result, false);
});

test("opaque compaction profile reference passes through", () => {
  assert.equal(
    validateModelParameters({ ...base, compaction_model_profile_id: "compactor-v2" })
      .compaction_model_profile_id,
    "compactor-v2",
  );
});

test("malformed context metadata is rejected", () => {
  for (const patch of [
    { tokenizer: "bogus" },
    { tokenizer: "O200K" },
    { tokenizer: " o200k" },
    { tokenizer: "" },
    { tokenizer: null },
    { compaction_model_profile_id: "" },
    { compaction_model_profile_id: "has space" },
    { compaction_model_profile_id: null },
    { compaction_model_profile_id: "x".repeat(201) },
  ]) {
    assert.throws(() =>
      validateModelParameters({ ...base, ...patch } as unknown as ModelParameters),
    );
  }
});

test("savedParameters preserves context metadata", () => {
  const model: ModelSpec = {
    base_url: "https://known.test/v1",
    ...base,
    tokenizer: "cl100k",
    compaction_model_profile_id: "compactor-1",
  };
  const saved = savedParameters(model);
  assert.equal(saved.tokenizer, "cl100k");
  assert.equal(saved.compaction_model_profile_id, "compactor-1");
});
