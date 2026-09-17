import assert from "node:assert/strict";

export async function seedPermissions(api, image, suffix) {
  await api(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "Permission provider",
      base_url: "http://permission-model:8080/v1",
      credential: { method: "api_key", api_key: "permission-model-test" },
      models: [`permission-model-${suffix}`, `alternate-model-${suffix}`].map(
        (name) => ({
          display_name: name,
          model: {
            model: name,
            context_window: 64000,
            max_output_tokens: 4096,
            supports_images: false,
          },
        }),
      ),
    },
    201,
  );
  const models = (await api("/api/admin/model-profiles")).items;
  assert.equal(
    models.length,
    2,
    "disposable permission Model inventory must be unambiguous",
  );
  const select = (name) => {
    const matches = models.filter((model) => model.display_name === name);
    assert.equal(matches.length, 1, "missing or duplicate permission Model");
    assert(matches[0].model_profile_id, "stable Model identity missing");
    return matches[0].model_profile_id;
  };
  const modelID = select(`permission-model-${suffix}`);
  const alternateModelID = select(`alternate-model-${suffix}`);
  const template = await api(
    "/api/admin/templates",
    {
      name: `Permissions ${suffix}`,
      model_profile_id: modelID,
      system_prompt: "Use the requested tool.",
      max_model_requests: 5,
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
  return { template, alternateModelID };
}
