import assert from "node:assert/strict";
import test from "node:test";
import { createAccessCatalog } from "./catalog.mjs";

const options = {
  name: "Access fixture",
  modelName: "session-fixture",
  credential: "private-key",
  baseURL: "http://model-peer:8080/v1",
  runtimeImage: "sha256:" + "a".repeat(64),
  systemPrompt: "Fixture prompt",
  maxModelRequests: 8,
};
test("access consumers use current Provider/Model contracts and returned Template revision", async () => {
  const calls = [];
  const admin = {
    request: async (path, request = {}) => {
      calls.push(path);
      if (path === "/api/admin/provider-connections") {
        assert.equal(request.status, 201);
        assert.equal(request.body.credential.api_key, options.credential);
        assert.equal(request.body.base_url, options.baseURL);
        assert.equal(request.body.models[0].model.model, options.modelName);
        return { body: { connection_id: "provider" } };
      }
      if (path === "/api/admin/model-profiles") {
        assert.equal(request.body, undefined);
        return {
          body: {
            items: [
              {
                provider_connection_id: "unrelated",
                model_profile_id: "foreign",
              },
              {
                provider_connection_id: "provider",
                model_profile_id: "stable",
              },
            ],
          },
        };
      }
      assert.equal(path, "/api/admin/templates");
      assert.equal(request.body.model_profile_id, "stable");
      assert.equal(request.body.model_profile_revision_id, undefined);
      assert.equal(request.body.runtime.image_ref, options.runtimeImage);
      return { body: { template_id: "template", revision: 9 } };
    },
  };
  const result = await createAccessCatalog(admin, options);
  assert.equal(result.template.revision, 9);
  assert.equal(result.model.model_profile_id, "stable");
  assert.equal(calls.length, 3);
});
test("ambiguous or foreign Model inventories cannot create a Template", async () => {
  for (const models of [
    [],
    [{ provider_connection_id: "wrong", model_profile_id: "foreign" }],
    [
      { provider_connection_id: "provider" },
      { provider_connection_id: "provider" },
    ],
  ]) {
    await assert.rejects(
      createAccessCatalog(
        {
          request: async (path) => {
            assert.notEqual(path, "/api/admin/templates");
            return {
              body: path.endsWith("provider-connections")
                ? { connection_id: "provider" }
                : { items: models },
            };
          },
        },
        options,
      ),
    );
  }
});
