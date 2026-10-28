import { describe, expect, it } from "vitest";
import {
  matchingProviderTokenLimits,
  providerTokenLimitsSchema,
} from "../../src/domain/provider-token-limits.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import { parseStoredRunSnapshot } from "../../src/domain/stored-run-snapshot.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { binding as sessionBinding } from "../support/fixtures.js";

const binding = {
  organization_id: "organization-1",
  connection_id: "provider-1",
  provider_key: "deepseek" as const,
  request_protocol: "openai_chat_completions" as const,
  base_url: "https://api.deepseek.com",
  model: "test-model",
  credential_revision: "credential-1",
};
function limits() {
  return {
    source: "models" as const,
    source_revision: 1,
    binding: { ...binding },
    context_tokens: 8192,
    max_output_tokens: 1024,
  };
}

describe("Provider token limit authority", () => {
  it("freezes published primary and fallback observations through stored Run round trips", () => {
    const wire = executionConfiguration();
    const primary = { ...wire.models[0]!, provider_token_limits: limits() };
    const fallback = {
      ...primary,
      model_profile_id: "model-2",
      connection_id: "provider-2",
      provider_token_limits: { ...limits(), binding: { ...binding, connection_id: "provider-2" } },
    };
    wire.providers.push({ ...wire.providers[0]!, connection_id: "provider-2" });
    wire.models = [primary, fallback];
    wire.agents[0]!.failover = "before_output";
    wire.agents[0]!.fallback_model_profile_ids = ["model-2"];
    const parsed = parseExecutionConfiguration(wire);
    const captured = runSnapshot({
      configuration: publicExecutionConfiguration(parsed),
      identity: sessionBinding(),
      overrides: {},
      accessRevision: "access-1",
      clientMcpRevisionId: "mcp-1",
      deadlineAt: new Date(Date.now() + 60000),
    });
    primary.provider_token_limits.context_tokens = 1;
    expect(captured.executionSpec.model.providerTokenLimits).toEqual(limits());
    expect(captured.executionSpec.fallbackModels?.[0]?.model.providerTokenLimits).toEqual(
      fallback.provider_token_limits,
    );
    const restored = parseStoredRunSnapshot(JSON.parse(JSON.stringify(captured)));
    expect(restored).toEqual(captured);
    expect(restored.executionSpec.model.providerTokenLimits).not.toHaveProperty("credential");
  });
  it("retains unknown coverage and independently observed dimensions", () => {
    const value = limits();
    const parsed = providerTokenLimitsSchema.parse(value);
    expect(parsed).toEqual(value);
    expect(parsed).not.toHaveProperty("context_includes_media");
    expect(parsed).not.toHaveProperty("output_includes_reasoning");
    expect(matchingProviderTokenLimits(parsed, binding)).toEqual(value);
    expect(matchingProviderTokenLimits(undefined, binding)).toBeUndefined();
  });
  it.each([
    "organization_id",
    "connection_id",
    "provider_key",
    "request_protocol",
    "base_url",
    "model",
    "credential_revision",
  ] as const)("never authorizes an observation from another %s", (field) => {
    const value = providerTokenLimitsSchema.parse(limits());
    expect(
      matchingProviderTokenLimits(value, {
        ...binding,
        [field]: field === "base_url" ? "https://other.example.test" : "other",
      }),
    ).toBeUndefined();
    expect(value).toEqual(limits());
  });
  it("compares canonical endpoints without letting URL credentials or queries through", () => {
    const value = providerTokenLimitsSchema.parse(limits());
    expect(
      matchingProviderTokenLimits(value, { ...binding, base_url: "https://API.DEEPSEEK.COM:443/" }),
    ).toEqual(value);
    for (const base_url of [
      "https://secret@api.deepseek.com",
      "https://api.deepseek.com?token=secret",
      "https://api.deepseek.com/#fragment",
      "https://",
      "file:///tmp/model",
    ]) {
      expect(
        providerTokenLimitsSchema.safeParse({ ...limits(), binding: { ...binding, base_url } })
          .success,
      ).toBe(false);
      expect(matchingProviderTokenLimits(value, { ...binding, base_url })).toBeUndefined();
    }
  });
  it("rejects secret fields, empty dimensions and coerced limits", () => {
    const value = limits();
    for (const invalid of [
      { ...value, context_tokens: "8192" },
      { ...value, source_revision: 0 },
      { ...value, max_output_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...value, binding: { ...binding, secret: "private-canary" } },
      { ...value, binding: { ...binding, credential_revision: 1 } },
      { source: "models", source_revision: 1, binding },
    ])
      expect(providerTokenLimitsSchema.safeParse(invalid).success).toBe(false);
  });
});
