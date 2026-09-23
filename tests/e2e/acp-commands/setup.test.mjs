import assert from "node:assert/strict";
import test from "node:test";
import { seedCommands } from "./setup.mjs";

test("commands use a Provider, stable Model and returned Template revision", async () => {
  const calls = [];
  const api = async (path, body, status) => {
    calls.push(path);
    if (path === "/api/admin/provider-connections") {
      assert.equal(status, 201);
      assert.equal(body.base_url, "http://commands-model-peer:8080/v1");
      assert.equal(body.models[0].model.model, "command-model");
      assert.notEqual(
        new URL(body.base_url).hostname,
        body.credential.api_key,
        "credential sentinel must not equal the public peer hostname",
      );
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
    return { template_id: "template", revision: 8 };
  };
  assert.deepEqual(await seedCommands(api, "sha256:candidate"), {
    template_id: "template",
    revision: 8,
  });
  assert.equal(calls.length, 3);
});
test("ambiguous Model inventory fails before Template creation", async () => {
  await assert.rejects(
    seedCommands(async (path) => {
      assert.notEqual(path, "/api/admin/templates");
      return { items: [{}, {}] };
    }, "sha256:candidate"),
  );
});
