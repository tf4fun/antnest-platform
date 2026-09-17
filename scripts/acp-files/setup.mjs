import assert from "node:assert/strict";

export async function assertAgentDenied(client) {
  await assert.rejects(
    client.request("new", { cwd: "/workspace", mcpServers: [] }),
    (error) => error.code === -32020 && error.data?.code === "access_denied",
  );
  assert.deepEqual(
    client.updates,
    [],
    "Agent denial disclosed Session updates",
  );
}

export async function seedFiles(api, image) {
  await api(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "File SSE provider",
      base_url: "http://file-model:8080/v1",
      credential: { method: "api_key", api_key: "file-model-test" },
      models: [
        {
          display_name: "File SSE model",
          model: {
            model: "file-model",
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
    "disposable file Model inventory must be unambiguous",
  );
  return api(
    "/api/admin/templates",
    {
      name: "File acceptance",
      model_profile_id: models[0].model_profile_id,
      system_prompt: "Use the requested tool.",
      max_model_requests: 4,
      runtime: { image_ref: image },
    },
    201,
  );
}
