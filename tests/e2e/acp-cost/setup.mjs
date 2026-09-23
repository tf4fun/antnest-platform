import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
export function modelConfig(pricing) {
  return {
    model: pricing ? "priced-model" : "unknown-model",
    context_window: 64000,
    max_output_tokens: 4096,
    supports_images: false,
    ...(pricing ? { pricing } : {}),
  };
}
async function currentPrice(request, model, pricing) {
  assert(model.model_profile_id && Number.isInteger(model.revision));
  const { body } = await request(
    `/api/admin/model-profiles/${model.model_profile_id}`,
  );
  assert.equal(body.model_profile_id, model.model_profile_id);
  assert.equal(body.revision, model.revision);
  assert.deepEqual(
    body.model.pricing,
    pricing,
    "current price projection mismatch",
  );
  assert(
    !JSON.stringify(body).includes("cost-model-test"),
    "BFF credential leak",
  );
  return body;
}
export async function createPricedModel(request, name, pricing, traces) {
  const result = await request("/api/admin/provider-connections", {
    status: 201,
    body: {
      provider_key: "deepseek",
      display_name: name,
      base_url: "http://acp-closeout-model:8080/v1",
      credential: { method: "api_key", api_key: "cost-model-test" },
      models: [{ display_name: name, model: modelConfig(pricing) }],
    },
  });
  traces.push({
    traceID: result.traceID,
    route: "/internal/provider-connections",
    publicRoute: "/api/admin/provider-connections",
  });
  const { body } = await request("/api/admin/model-profiles");
  const matches = body.items.filter(
    (m) => m.provider_connection_id === result.body.connection_id,
  );
  assert.equal(matches.length, 1, "priced Model identity missing or ambiguous");
  return currentPrice(request, matches[0], pricing);
}
export async function revisePricedModel(request, model, pricing, traces) {
  const result = await request(
    `/api/admin/model-profiles/${model.model_profile_id}/revisions`,
    {
      status: 201,
      body: {
        expected_version: model.revision,
        display_name: "Repriced fixture",
        model: modelConfig(pricing),
      },
    },
  );
  traces.push({
    traceID: result.traceID,
    route: "/internal/model-profiles/{model_profile_id}/revisions",
    publicRoute: "/api/admin/model-profiles/{model_profile_id}/revisions",
  });
  assert.equal(result.body.model_profile_id, model.model_profile_id);
  assert.equal(result.body.revision, model.revision + 1);
  return currentPrice(request, result.body, pricing);
}
export async function waitForPublication(read, before) {
  assert.match(before, /^[a-f0-9]{64}$/);
  const deadline = Date.now() + 15000;
  do {
    const state = await read();
    assert.equal(state.access_allowed, true);
    assert.match(state.configuration_revision, /^[a-f0-9]{64}$/);
    if (state.configuration_revision !== before) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("ACP current pricing publication timed out");
}

export async function waitForRestoredConfiguration(read, fingerprint) {
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const deadline = Date.now() + 120000;
  do {
    let state;
    try {
      state = await read();
    } catch (error) {
      // GatewayClient reports exact HTTP status mismatches as assertions.
      // Only the public startup-unavailable response is a recovery observation.
      if (!(
        error.code === "ERR_ASSERTION" &&
        error.actual === 503 &&
        error.expected === 200
      ))
        throw error;
    }
    if (state?.access_allowed && state.availability === "ready") {
      assert.equal(
        state.configuration_revision,
        fingerprint,
        "restart changed current pricing configuration",
      );
      return;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("ACP execution configuration did not recover after restart");
}
