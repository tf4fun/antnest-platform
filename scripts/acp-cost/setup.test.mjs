import assert from "node:assert/strict";
import test from "node:test";
import {
  createPricedModel,
  revisePricedModel,
  waitForPublication,
} from "./setup.mjs";
const rates = { currency: "USD", input_per_million: 2, output_per_million: 8 };
function fixture(mutate = () => {}) {
  const calls = [],
    traces = [];
  let current = {
    model_profile_id: "model",
    revision: 4,
    model: { pricing: rates },
  };
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === "/api/admin/provider-connections") {
      assert.equal(options.body.credential.api_key, "cost-model-test");
      assert.equal(options.body.models[0].model.base_url, undefined);
      return { body: { connection_id: "provider" }, traceID: "create" };
    }
    if (path === "/api/admin/model-profiles")
      return {
        body: { items: [{ ...current, provider_connection_id: "provider" }] },
      };
    if (path.endsWith("/revisions")) {
      assert.equal(options.body.expected_version, current.revision);
      assert.equal(options.body.api_key, undefined);
      assert.equal(options.body.model.base_url, undefined);
      current = {
        ...current,
        revision: current.revision + 1,
        model: options.body.model,
      };
      return { body: structuredClone(current), traceID: "edit" };
    }
    assert.equal(path, "/api/admin/model-profiles/model");
    const body = structuredClone(current);
    mutate(body);
    return { body };
  };
  return { request, calls, traces };
}
test("prices use Provider-owned credentials, stable Model identity and optimistic current edits", async () => {
  const f = fixture();
  const original = await createPricedModel(f.request, "cost", rates, f.traces);
  const next = { ...rates, input_per_million: 4 };
  const revised = await revisePricedModel(f.request, original, next, f.traces);
  assert.equal(revised.revision, 5);
  assert.deepEqual(original.model.pricing, rates);
  assert.equal(f.traces.length, 2);
  assert(f.calls.every((c) => !c.path.includes("model-profile-revisions")));
});
test("current price or credential projection corruption fails setup", async () => {
  for (const mutate of [
    (m) => {
      m.model.pricing.input_per_million = 99;
    },
    (m) => {
      m.api_key = "cost-model-test";
    },
  ]) {
    const f = fixture(mutate);
    await assert.rejects(createPricedModel(f.request, "cost", rates, f.traces));
  }
});
test("publication waits for an authorized changed ACP configuration fingerprint", async () => {
  let count = 0;
  await waitForPublication(
    async () => ({
      access_allowed: true,
      configuration_revision: ++count < 2 ? "a".repeat(64) : "b".repeat(64),
    }),
    "a".repeat(64),
  );
  assert.equal(count, 2);
  await assert.rejects(
    waitForPublication(
      async () => ({
        access_allowed: false,
        configuration_revision: "b".repeat(64),
      }),
      "a".repeat(64),
    ),
  );
});

test("restart readiness waits for authorized execution with the original pricing fingerprint", async () => {
  const { waitForRestoredConfiguration } = await import("./setup.mjs");
  let calls = 0;
  await waitForRestoredConfiguration(
    async () =>
      ++calls === 1
        ? {
            access_allowed: false,
            availability: "offline",
            configuration_revision: null,
          }
        : {
            access_allowed: true,
            availability: "ready",
            configuration_revision: "a".repeat(64),
          },
    "a".repeat(64),
  );
  assert.equal(calls, 2);
  await assert.rejects(
    waitForRestoredConfiguration(
      async () => ({
        access_allowed: true,
        availability: "ready",
        configuration_revision: "b".repeat(64),
      }),
      "a".repeat(64),
    ),
  );
});

test("restart readiness retries only the public 503, never authentication or other failures", async () => {
  const { waitForRestoredConfiguration } = await import("./setup.mjs");
  let calls = 0;
  await waitForRestoredConfiguration(async () => {
    if (++calls === 1)
      throw new assert.AssertionError({
        actual: 503,
        expected: 200,
        operator: "strictEqual",
      });
    return {
      access_allowed: true,
      availability: "ready",
      configuration_revision: "a".repeat(64),
    };
  }, "a".repeat(64));
  assert.equal(calls, 2);
  for (const status of [401, 403, 500])
    await assert.rejects(
      waitForRestoredConfiguration(async () => {
        throw new assert.AssertionError({
          actual: status,
          expected: 200,
          operator: "strictEqual",
        });
      }, "a".repeat(64)),
    );
});
