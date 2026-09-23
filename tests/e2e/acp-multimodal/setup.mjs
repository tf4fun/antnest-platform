import assert from "node:assert/strict";

export async function seedNative(api, image) {
  await api(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "Native input provider",
      base_url: "http://acp-closeout-model:8080/v1",
      credential: { method: "api_key", api_key: "native-model-test" },
      models: [true, false].map((native) => ({
        display_name: native ? "Native fixture" : "Text fixture",
        model: {
          model: native ? "native-model" : "text-model",
          context_window: 64000,
          max_output_tokens: 4096,
          supports_images: native,
          supports_audio: native,
          supports_pdf: native,
        },
      })),
    },
    201,
  );
  const models = (await api("/api/admin/model-profiles")).items;
  assert.equal(
    models.length,
    2,
    "disposable native Model inventory must be unambiguous",
  );
  const ids = [];
  for (const native of [true, false]) {
    const matches = models.filter(
      (model) => model.model.model === (native ? "native-model" : "text-model"),
    );
    assert.equal(
      matches.length,
      1,
      "native Model identity missing or ambiguous",
    );
    const id = matches[0].model_profile_id;
    assert(id);
    const projected = await api(`/api/admin/model-profiles/${id}`);
    assert.equal(projected.model_profile_id, id);
    for (const key of ["supports_images", "supports_audio", "supports_pdf"])
      assert.equal(projected.model[key] ?? false, native, `BFF lost ${key}`);
    assert(
      !JSON.stringify(projected).includes("native-model-test"),
      "BFF exposed credential",
    );
    ids.push(id);
  }
  const template = await api(
    "/api/admin/templates",
    {
      name: "Native acceptance",
      model_profile_id: ids[0],
      system_prompt: "Summarize native attachments.",
      max_model_requests: 5,
      runtime: { image_ref: image },
    },
    201,
  );
  return { template, textModelID: ids[1] };
}
