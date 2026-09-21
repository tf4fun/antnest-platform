import assert from "node:assert/strict";

export async function createAccessCatalog(admin, options) {
  const { body: provider } = await admin.request(
    "/api/admin/provider-connections",
    {
      status: 201,
      body: {
        provider_key: "deepseek",
        display_name: options.name,
        base_url: options.baseURL,
        credential: { method: "api_key", api_key: options.credential },
        models: [
          {
            display_name: options.name,
            model: {
              model: options.modelName,
              context_window: 64000,
              max_output_tokens: 4096,
              supports_images: false,
            },
          },
        ],
      },
    },
  );
  const inventory = (await admin.request("/api/admin/model-profiles")).body
    .items;
  const models = inventory.filter(
    (model) => model.provider_connection_id === provider.connection_id,
  );
  assert.equal(models.length, 1, "fixture Provider Model must be unambiguous");
  assert(models[0].model_profile_id, "stable Model ID missing");
  const { body: template } = await admin.request("/api/admin/templates", {
    status: 201,
    body: {
      name: options.name,
      model_profile_id: models[0].model_profile_id,
      system_prompt: options.systemPrompt,
      max_model_requests: options.maxModelRequests,
      runtime: { image_ref: options.runtimeImage },
    },
  });
  return { provider, model: models[0], template };
}
