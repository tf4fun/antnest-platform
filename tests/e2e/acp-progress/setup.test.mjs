import assert from "node:assert/strict";
import test from "node:test";
import { seedProgress } from "./setup.mjs";

test("progress deployment seeds a Provider and references the returned stable Model identity", async () => {
  const calls = [];
  const api = async (path, body, status) => {
    calls.push(path);
    if (path === "/api/admin/provider-connections") {
      assert.equal(status, 201);
      assert.equal(body.provider_key, "deepseek");
      assert.equal(body.base_url, "http://progress-model:8080/v1");
      assert.equal(body.credential.api_key, "progress-model-test");
      assert.equal(body.models[0].model.model, "progress-model");
      return {};
    }
    if (path === "/api/admin/model-profiles") {
      assert.equal(body, undefined, "retired Model Profile creation API");
      return { items: [{ model_profile_id: "model-current" }] };
    }
    assert.equal(path, "/api/admin/templates");
    assert.equal(status, 201);
    assert.equal(body.model_profile_id, "model-current");
    assert.equal(body.model_profile_revision_id, undefined);
    assert.equal(body.runtime.image_ref, "sha256:candidate");
    assert.equal(
      body.runtime.mcp_servers[0].command,
      "/usr/local/bin/managed-mcp-fixture",
    );
    return { template_id: "template-current", revision: 7 };
  };
  assert.deepEqual(await seedProgress(api, "sha256:candidate"), {
    template_id: "template-current",
    revision: 7,
  });
  assert.deepEqual(calls, [
    "/api/admin/provider-connections",
    "/api/admin/model-profiles",
    "/api/admin/templates",
  ]);
});

test("ambiguous model inventory cannot select an unrelated model", async () => {
  let templates = 0;
  await assert.rejects(
    seedProgress(async (path) => {
      if (path === "/api/admin/templates") templates++;
      return {
        items: [{ model_profile_id: "one" }, { model_profile_id: "two" }],
      };
    }, "sha256:candidate"),
  );
  assert.equal(templates, 0);
});
