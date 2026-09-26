import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assertResourceId,
  modelEdit,
  modelParameters,
  templateInput,
} from "./contracts.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export async function catalog(admin, image, secrets) {
  const api = async (path, body, status = 200, headers = {}) =>
    (await admin.request(path, { body, status, headers })).body;
  const replay = async (path, body, id) => {
    const headers = { "Idempotency-Key": randomUUID() };
    const first = await api(path, body, 201, headers),
      second = await api(path, body, 201, headers);
    assert.equal(
      first[id],
      second[id],
      "catalog command replay duplicated identity",
    );
    assertSecretFree(JSON.stringify([first, second]), secrets);
    return first;
  };
  const providers = await api("/api/admin/model-catalog");
  assert(
    providers.revision &&
      providers.providers.some((p) => p.provider_key === "deepseek") &&
      providers.providers.some((p) => p.provider_key === "openrouter"),
    "current builtin Provider catalog missing",
  );
  const provider = await replay(
    "/api/admin/provider-connections",
    {
      provider_key: "deepseek",
      display_name: "Stage 3 provider",
      base_url: "http://stage3-model-peer:8080/v1",
      credential: { method: "api_key", api_key: "stage3-initial-key" },
      models: [],
    },
    "connection_id",
  );
  assert.equal((await api("/api/admin/provider-connections")).items.length, 1);
  const model = await replay(
    "/api/admin/model-profiles",
    {
      display_name: "Stage 3 model",
      provider_connection_id: provider.connection_id,
      model: {
        model: "stage3-model",
        context_window: 8192,
        max_output_tokens: 1024,
        supports_images: false,
      },
    },
    "model_profile_id",
  );
  assert.equal((await api("/api/admin/model-profiles")).items.length, 1);
  const bad = await api(
    "/api/admin/templates",
    {
      ...templateInput(model, "Rejected image"),
      runtime: { image_ref: "runtime:bad tag" },
    },
    400,
  );
  assert.equal(bad.code, "runtime_image_invalid");
  assert.equal((await api("/api/admin/templates")).items.length, 0);
  const template = await replay(
    "/api/admin/templates",
    {
      ...templateInput(model, "Stage 3 Template"),
    },
    "template_id",
  );
  assert.equal(template.runtime.image_ref, image);
  assert.equal((await api("/api/admin/templates")).items.length, 1);
  const secondary = await api(
    "/api/admin/model-profiles",
    {
      display_name: "Stage 3 secondary",
      provider_connection_id: provider.connection_id,
      model: { ...modelParameters(model.model), model: "stage3-secondary" },
    },
    201,
  );
  const otherTemplate = await api(
    "/api/admin/templates",
    {
      ...templateInput(secondary, "Stage 3 Secondary Template"),
      runtime: { image_ref: "antnest/not-installed:stage3-migration" },
    },
    201,
  );
  assert.equal(
    otherTemplate.runtime.image_ref,
    "antnest/not-installed:stage3-migration",
    "Template must preserve a syntactically valid reference without resolving the image",
  );
  for (const [path, id, expected] of [
    [
      "model-profiles",
      "model_profile_id",
      [model.model_profile_id, secondary.model_profile_id],
    ],
    [
      "templates",
      "template_id",
      [template.template_id, otherTemplate.template_id],
    ],
  ]) {
    const first = await api(`/api/admin/${path}?limit=1`);
    assert(first.next_after_id);
    assert.equal(first.items.length, 1);
    const second = await api(
      `/api/admin/${path}?limit=1&after_id=${encodeURIComponent(first.next_after_id)}`,
    );
    assert.equal(second.items.length, 1);
    assert(!second.next_after_id);
    assert.deepEqual(
      new Set([...first.items, ...second.items].map((item) => item[id])),
      new Set(expected),
    );
  }
  assertResourceId("provider", provider.connection_id);
  for (const item of [model, secondary])
    assertResourceId("model", item.model_profile_id);
  for (const item of [template, otherTemplate])
    assertResourceId("template", item.template_id);
  return { provider, model, template };
}
export async function editCatalog(admin, original, secrets) {
  const api = async (path, body, status = 200) =>
    (await admin.request(path, { body, status })).body;
  const { provider, model, template } = original;
  const rotated = await api(
    `/api/admin/provider-connections/${provider.connection_id}/credentials`,
    {
      expected_version: provider.credential_version,
      credential: { method: "api_key", api_key: "stage3-rotated-key" },
    },
    201,
  );
  assert.notEqual(rotated.credential_version, provider.credential_version);
  const edited = await api(
    `/api/admin/model-profiles/${model.model_profile_id}/revisions`,
    modelEdit(model),
    201,
  );
  assert.equal(edited.model_profile_id, model.model_profile_id);
  assert.equal(edited.revision, model.revision + 1);
  await api(
    `/api/admin/model-profiles/${model.model_profile_id}/revisions`,
    modelEdit(model),
    409,
  );
  assert.equal(
    (await api(`/api/admin/model-profiles/${model.model_profile_id}`)).revision,
    edited.revision,
  );
  const revised = await api(
    `/api/admin/templates/${template.template_id}/revisions`,
    {
      ...templateInput(edited, "Stage 3 Template v2"),
      system_prompt: "Use the requested tool with revised configuration.",
      max_model_requests: 12,
      runtime: { image_ref: template.runtime.image_ref },
    },
    201,
  );
  assert.equal(revised.revision, template.revision + 1);
  assert.equal(
    (await api(`/api/admin/templates/${template.template_id}`)).revision,
    revised.revision,
  );
  const history = await api(
    `/api/admin/templates/${template.template_id}/revisions/${template.revision}`,
  );
  assert.equal(history.model_profile_id, model.model_profile_id);
  assert.equal(history.system_prompt, template.system_prompt);
  assert.equal(history.max_model_requests, 8);
  assertSecretFree(
    JSON.stringify([rotated, edited, revised, history]),
    secrets,
  );
  return { provider: rotated, model: edited, template: revised };
}
