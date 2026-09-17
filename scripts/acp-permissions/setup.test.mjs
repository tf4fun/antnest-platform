import assert from "node:assert/strict";
import test from "node:test";
import { seedPermissions } from "./setup.mjs";

test("permission fixture seeds two current Models and uses stable default identity", async () => {
  const calls = [];
  const api = async (path, body, status) => {
    calls.push(path);
    if (path === "/api/admin/provider-connections") {
      assert.equal(status, 201);
      assert.deepEqual(
        body.models.map((x) => x.model.model),
        ["permission-model-test-run", "alternate-model-test-run"],
      );
      assert.notEqual(new URL(body.base_url).hostname, body.credential.api_key);
      return {};
    }
    if (path === "/api/admin/model-profiles")
      return {
        items: [
          {
            model_profile_id: "alternate",
            display_name: "alternate-model-test-run",
          },
          {
            model_profile_id: "default",
            display_name: "permission-model-test-run",
          },
        ],
      };
    assert.equal(path, "/api/admin/templates");
    assert.equal(body.model_profile_id, "default");
    assert.equal(body.model_profile_revision_id, undefined);
    assert.equal(body.runtime.image_ref, "sha256:fixture");
    assert.equal(
      body.runtime.mcp_servers[0].command,
      "/usr/local/bin/managed-mcp-fixture",
    );
    return { template_id: "template", revision: 7 };
  };
  assert.deepEqual(await seedPermissions(api, "sha256:fixture", "test-run"), {
    template: { template_id: "template", revision: 7 },
    alternateModelID: "alternate",
  });
  assert.equal(calls.length, 3);
});
test("permission fixture rejects missing or ambiguous Model identities", async () => {
  for (const items of [
    [],
    [{}, {}],
    [
      { display_name: "permission-model-test-run" },
      { display_name: "permission-model-test-run" },
    ],
  ])
    await assert.rejects(
      seedPermissions(
        async (path) => {
          assert.notEqual(path, "/api/admin/templates");
          return { items };
        },
        "sha256:fixture",
        "test-run",
      ),
    );
});
