import assert from "node:assert/strict";
export async function seed(api, image) {
  await api(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "Restart recovery Provider",
      base_url: "http://restart-model-peer:8080/v1",
      credential: { method: "api_key", api_key: "restart-fixture-key" },
      models: [
        {
          display_name: "Restart Model",
          model: {
            model: "restart-model",
            context_window: 64000,
            max_output_tokens: 2048,
            supports_images: false,
          },
        },
      ],
    },
    201,
  );
  const models = (await api("/api/admin/model-profiles")).items;
  assert.equal(models.length, 1);
  const template = await api(
    "/api/admin/templates",
    {
      name: "Restart recovery",
      model_profile_id: models[0].model_profile_id,
      system_prompt: "Use the requested Tool.",
      max_model_requests: 5,
      runtime: { image_ref: image },
    },
    201,
  );
  return { model: models[0], template };
}
