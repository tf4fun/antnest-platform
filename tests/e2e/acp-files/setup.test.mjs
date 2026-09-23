import assert from "node:assert/strict";
import test from "node:test";
import { seedFiles, assertAgentDenied } from "./setup.mjs";

test("file fixture creates a Provider and uses a stable Model and returned Template revision", async () => {
  const api = async (path, body, status) => {
    if (path === "/api/admin/provider-connections") {
      assert.equal(status, 201);
      assert.equal(body.base_url, "http://file-model:8080/v1");
      assert.equal(body.models[0].model.model, "file-model");
      return {};
    }
    if (path === "/api/admin/model-profiles") {
      assert.equal(body, undefined, "retired Model creation API");
      return { items: [{ model_profile_id: "current-model" }] };
    }
    assert.equal(path, "/api/admin/templates");
    assert.equal(body.model_profile_id, "current-model");
    assert.equal(body.model_profile_revision_id, undefined);
    assert.equal(body.runtime.image_ref, "sha256:candidate");
    return { template_id: "current-template", revision: 7 };
  };
  assert.deepEqual(await seedFiles(api, "sha256:candidate"), {
    template_id: "current-template",
    revision: 7,
  });
});

test("Agent isolation requires an ACP access denial, not a transport error or successful upgrade", async () => {
  const denied = Object.assign(new Error("Agent access is not allowed"), {
    code: -32020,
    data: { code: "access_denied" },
  });
  await assertAgentDenied({
    updates: [],
    request: async () => {
      throw denied;
    },
  });
  for (const request of [
    async () => ({}),
    async () => {
      throw new Error("disconnected");
    },
    async () => {
      throw { ...denied, code: -32603 };
    },
  ])
    await assert.rejects(assertAgentDenied({ updates: [], request }));
  await assert.rejects(
    assertAgentDenied({
      updates: [{ sessionId: "private" }],
      request: async () => {
        throw denied;
      },
    }),
  );
});

test("ambiguous Model inventory fails before creating a Template", async () => {
  await assert.rejects(
    seedFiles(async (path) => {
      assert.notEqual(path, "/api/admin/templates");
      return {
        items: [{ model_profile_id: "one" }, { model_profile_id: "two" }],
      };
    }, "sha256:candidate"),
  );
});
