import assert from "node:assert/strict";

export function templateBody(modelId, image, server = "alpha") {
  return {
    name: "Managed MCP acceptance",
    model_profile_id: modelId,
    system_prompt: "Use the requested tools and report their results.",
    max_model_requests: 12,
    runtime: {
      image_ref: image,
      resources: {
        memory_bytes: 536870912,
        pids_limit: 256,
        tmpfs_bytes: 67108864,
      },
      mcp_servers: [
        {
          id: server,
          command: "/usr/local/bin/managed-mcp-fixture",
          args: [],
          env: {},
          secret_env: { FIXTURE_SECRET: { value: "managed-env-canary" } },
        },
      ],
    },
  };
}
export async function seedManaged(api, image) {
  await api(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "Managed provider",
      base_url: "http://managed-model:8080/v1",
      credential: { method: "api_key", api_key: "managed-model-test" },
      models: [
        {
          display_name: "Managed model",
          model: {
            model: "managed-model",
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
    "disposable Managed Model inventory must be unambiguous",
  );
  return api(
    "/api/admin/templates",
    templateBody(models[0].model_profile_id, image),
    201,
  );
}
