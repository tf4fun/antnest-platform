import assert from "node:assert/strict";

export async function seedCommands(api, image) {
  await api(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "Command provider",
      base_url: "http://commands-model-peer:8080/v1",
      credential: { method: "api_key", api_key: "acp-closeout-model" },
      models: [
        {
          display_name: "Command model",
          model: {
            model: "command-model",
            context_window: 64000,
            max_output_tokens: 4096,
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
    "disposable command Model inventory must be unambiguous",
  );
  return api(
    "/api/admin/templates",
    {
      name: "Command acceptance",
      model_profile_id: models[0].model_profile_id,
      system_prompt: "Use the requested tool.",
      max_model_requests: 5,
      runtime: { image_ref: image },
    },
    201,
  );
}
