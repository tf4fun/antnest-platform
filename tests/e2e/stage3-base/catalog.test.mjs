import assert from "node:assert/strict";
import test from "node:test";
import { catalog } from "./catalog.mjs";

test("catalog fixture uses current Provider ownership, malformed-image rejection and exact replay/pagination", async () => {
  const providerId = `provider_${"a".repeat(32)}`;
  const image = `sha256:${"a".repeat(64)}`,
    models = [],
    templates = [],
    replay = new Map();
  const admin = {
    async request(path, options = {}) {
      const { body, status = 200, headers = {} } = options;
      if (path === "/api/admin/model-catalog")
        return {
          body: {
            revision: "current",
            providers: [
              { provider_key: "deepseek" },
              { provider_key: "openrouter" },
            ],
          },
        };
      if (path === "/api/admin/provider-connections") {
        if (!body) return { body: { items: [{ connection_id: providerId }] } };
        assert.equal(status, 201);
        assert(body.credential.api_key);
        assert.deepEqual(body.models, []);
        return { body: { connection_id: providerId } };
      }
      const name = path.includes("model-profiles") ? "models" : "templates";
      const items = name === "models" ? models : templates;
      const id = name === "models" ? "model_profile_id" : "template_id";
      if (body) {
        if (body.name === "Rejected image") {
          assert.equal(
            body.runtime.image_ref,
            "runtime:bad tag",
            "a missing image is now a valid Template reference",
          );
          assert.equal(status, 400);
          return { body: { code: "runtime_image_invalid" } };
        }
        if (name === "models") {
          assert.equal(body.provider_connection_id, providerId);
          assert.equal(body.api_key, undefined);
          assert.equal(body.model.base_url, undefined);
        } else {
          assert(body.model_profile_id);
          assert.equal(body.model_profile_revision_id, undefined);
          assert.equal(
            body.runtime?.image_ref ?? image,
            body.name.includes("Secondary")
              ? "antnest/not-installed:stage3-migration"
              : image,
            "Template preserves valid tags or uses the configured default",
          );
        }
        assert.equal(status, 201);
        const key = headers["Idempotency-Key"];
        if (key && replay.has(key)) return { body: replay.get(key) };
        const item = {
          ...body,
          ...(name === "models"
            ? { model: { ...body.model, base_url: "http://provider-peer/v1" } }
            : {}),
          [id]: `${name === "models" ? "model" : "template"}_${items.length.toString(16).padStart(32, "0")}`,
          revision: 1,
          ...(name === "templates"
            ? { runtime: { image_ref: body.runtime?.image_ref ?? image } }
            : {}),
        };
        items.push(item);
        if (key) replay.set(key, item);
        return { body: item };
      }
      const url = new URL(path, "http://fixture");
      if (!url.search) return { body: { items } };
      const second = url.searchParams.has("after_id");
      return {
        body: {
          items: [items[second ? 1 : 0]],
          ...(!second ? { next_after_id: items[0][id] } : {}),
        },
      };
    },
  };
  const result = await catalog(admin, image, ["private-canary"]);
  assert.equal(result.model.model_profile_id, `model_${"0".repeat(32)}`);
  assert.equal(models.length, 2);
  assert.equal(templates.length, 2);
});
