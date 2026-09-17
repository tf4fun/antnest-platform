import assert from "node:assert/strict";

export async function seedPlans(api, image) {
  await api(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "Plan SSE provider",
      base_url: "http://plan-model:8080/v1",
      credential: { method: "api_key", api_key: "plan-model-test" },
      models: [
        {
          display_name: "Plan SSE model",
          model: {
            model: "plan-model",
            context_window: 64000,
            max_output_tokens: 16384,
            supports_images: false,
          },
        },
      ],
    },
    201,
  );
  const models = (await api("/api/admin/model-profiles")).items;
  assert.equal(
    models.length,
    1,
    "disposable Plan Model inventory must be unambiguous",
  );
  return api(
    "/api/admin/templates",
    {
      name: "Plan acceptance",
      model_profile_id: models[0].model_profile_id,
      system_prompt: "Use the requested tool.",
      max_model_requests: 5,
      runtime: { image_ref: image },
    },
    201,
  );
}
