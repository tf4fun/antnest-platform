import assert from "node:assert/strict";
import { test } from "node:test";
import { seedManaged, templateBody } from "./setup.mjs";

test("Managed setup uses Provider connections, stable Models and returned Template revisions", async () => {
  const calls = [];
  const api = async (path, body, status) => {
    calls.push({ path, body, status });
    if (path === "/api/admin/model-profiles")
      return { items: [{ model_profile_id: "model-stable" }] };
    return { template_id: "template", revision: 7 };
  };
  const result = await seedManaged(api, "antnest/antnest-runtime:fixture");
  assert.equal(result.revision, 7);
  assert.deepEqual(
    calls.map((c) => c.path),
    [
      "/api/admin/provider-connections",
      "/api/admin/model-profiles",
      "/api/admin/templates",
    ],
  );
  assert.equal(calls[0].status, 201);
  assert.equal(calls[0].body.base_url, "http://managed-model:8080/v1");
  assert.equal(calls[0].body.credential.api_key, "managed-model-test");
  assert.equal(calls[2].body.model_profile_id, "model-stable");
  assert(!Object.hasOwn(calls[2].body, "model_profile_revision_id"));
  assert.equal(
    calls[2].body.runtime.image_ref,
    "antnest/antnest-runtime:fixture",
  );
  assert.deepEqual(calls[2].body.runtime.mcp_servers, [
    {
      id: "alpha",
      command: "/usr/local/bin/managed-mcp-fixture",
      args: [],
      env: {},
      secret_env: { FIXTURE_SECRET: { value: "managed-env-canary" } },
    },
  ]);
  assert.equal(
    templateBody("model-stable", "sha256:image", "beta").runtime.mcp_servers[0]
      .id,
    "beta",
  );
});

test("ambiguous disposable Model inventory is rejected", async () => {
  for (const items of [
    [],
    [{ model_profile_id: "a" }, { model_profile_id: "b" }],
  ])
    await assert.rejects(
      seedManaged(
        async (path) => (path.endsWith("model-profiles") ? { items } : {}),
        "image",
      ),
    );
});
