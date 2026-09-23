import assert from "node:assert/strict";
import test from "node:test";
import { seedNative } from "./setup.mjs";
const model = (native) => ({
  model_profile_id: native ? "native" : "text",
  model: {
    model: native ? "native-model" : "text-model",
    supports_images: native,
    supports_audio: native,
    supports_pdf: native,
  },
});
function fixture(mutate = () => {}) {
  const calls = [];
  const api = async (path, body, status) => {
    calls.push(path);
    if (path === "/api/admin/provider-connections") {
      assert.equal(status, 201);
      assert.equal(body.base_url, "http://acp-closeout-model:8080/v1");
      assert.notEqual(new URL(body.base_url).hostname, body.credential.api_key);
      assert.deepEqual(
        body.models.map((m) => m.model.supports_audio),
        [true, false],
      );
      assert.deepEqual(
        body.models.map((m) => m.model.supports_pdf),
        [true, false],
      );
      return {};
    }
    if (path === "/api/admin/model-profiles")
      return { items: [model(false), model(true)] };
    if (
      path === "/api/admin/model-profiles/native" ||
      path === "/api/admin/model-profiles/text"
    ) {
      const value = model(path.endsWith("native"));
      mutate(value);
      return value;
    }
    assert.equal(path, "/api/admin/templates");
    assert.equal(body.model_profile_id, "native");
    assert.equal(body.model_profile_revision_id, undefined);
    assert.equal(body.runtime.image_ref, "sha256:runtime");
    return { template_id: "template", revision: 6 };
  };
  return { api, calls };
}
test("native capability projections use current Provider/Model APIs and returned Template revision", async () => {
  const f = fixture();
  assert.deepEqual(await seedNative(f.api, "sha256:runtime"), {
    template: { template_id: "template", revision: 6 },
    textModelID: "text",
  });
  assert.equal(f.calls.length, 5);
});
test("capability or credential projection regression fails before creating a Template", async () => {
  for (const mutate of [
    (m) => {
      m.model.supports_audio = !m.model.supports_audio;
    },
    (m) => {
      m.model.supports_pdf = !m.model.supports_pdf;
    },
    (m) => {
      m.api_key = "native-model-test";
    },
  ]) {
    const f = fixture(mutate);
    await assert.rejects(seedNative(f.api, "sha256:runtime"));
    assert(!f.calls.includes("/api/admin/templates"));
  }
});
