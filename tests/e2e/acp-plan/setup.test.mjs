import assert from "node:assert/strict";
import test from "node:test";
import { seedPlans } from "./setup.mjs";

test("Plan fixture uses Provider creation, stable Model identity and returned Template revision", async () => {
  const calls = [];
  const api = async (path, body, status) => {
    calls.push(path);
    if (path === "/api/admin/provider-connections") {
      assert.equal(status, 201);
      assert.equal(body.base_url, "http://plan-model:8080/v1");
      assert.equal(body.models[0].model.model, "plan-model");
      return {};
    }
    if (path === "/api/admin/model-profiles") {
      assert.equal(body, undefined);
      return { items: [{ model_profile_id: "stable" }] };
    }
    assert.equal(path, "/api/admin/templates");
    assert.equal(body.model_profile_id, "stable");
    assert.equal(body.model_profile_revision_id, undefined);
    assert.equal(body.runtime.image_ref, "sha256:candidate");
    return { template_id: "template", revision: 4 };
  };
  assert.deepEqual(await seedPlans(api, "sha256:candidate"), {
    template_id: "template",
    revision: 4,
  });
  assert.equal(calls.length, 3);
});
test("Plan setup refuses ambiguous Models before creating a Template", async () => {
  await assert.rejects(
    seedPlans(async (path) => {
      assert.notEqual(path, "/api/admin/templates");
      return { items: [{}, {}] };
    }, "sha256:candidate"),
  );
});
