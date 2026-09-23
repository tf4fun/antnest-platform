import assert from "node:assert/strict";

export async function seedProgress(api, image) {
  await api(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "Progress SSE provider",
      base_url: "http://progress-model:8080/v1",
      credential: { method: "api_key", api_key: "progress-model-test" },
      models: [
        {
          display_name: "Progress SSE model",
          model: {
            model: "progress-model",
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
    "disposable progress model inventory must be unambiguous",
  );
  const model = models[0];
  const template = await api(
    "/api/admin/templates",
    {
      name: "Progress acceptance",
      model_profile_id: model.model_profile_id,
      system_prompt: "Use the requested tool.",
      max_model_requests: 4,
      runtime: {
        image_ref: image,
        mcp_servers: [
          {
            id: "fixture",
            command: "/usr/local/bin/managed-mcp-fixture",
            args: [],
            env: {},
          },
        ],
      },
    },
    201,
  );
  return template;
}
