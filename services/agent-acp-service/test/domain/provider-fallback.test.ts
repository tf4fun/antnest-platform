import { describe, expect, it } from "vitest";
import {
  executionConfigurationCatalog,
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { configurationView } from "../../src/domain/session-configuration.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

function fixture() {
  const base = executionConfiguration();
  return parseExecutionConfiguration({
    ...base,
    providers: [
      ...base.providers,
      {
        ...base.providers[0],
        connection_id: "router",
        provider_key: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
      },
    ],
    models: [
      ...base.models,
      {
        ...base.models[0],
        model_profile_id: "backup",
        connection_id: "router",
        model: "openai/gpt-4o-mini",
        display_name: "GPT-4o mini",
      },
    ],
    agents: base.agents.map((a) => ({ ...a, fallback_model_profile_ids: ["backup"] })),
  });
}

describe("ordered Provider selection", () => {
  it("selects default, falls back with a visible notice, and restores without modifying intent", () => {
    const input = fixture();
    expect(resolveExecutionConfiguration(input, executionIdentity(), {}).modelProfileId).toBe(
      "model-1",
    );
    input.providers[0]!.enabled = false;
    const selected = resolveExecutionConfiguration(input, executionIdentity(), {});
    expect(selected.providerConnectionId).toBe("router");
    expect(selected.modelProfileId).toBe("backup");
    const view = configurationView({}, executionConfigurationCatalog(input, input.agents[0]!));
    expect(view.models.find((m) => m.id === "agent_default")?.name).toContain("GPT-4o mini");
    expect(view.notice).toContain("unavailable");
    expect(view.notice).toContain("GPT-4o mini");
    input.providers[0]!.enabled = true;
    expect(resolveExecutionConfiguration(input, executionIdentity(), {}).modelProfileId).toBe(
      "model-1",
    );
  });

  it("retains manual choice and rejects prompting when all connections are disabled", () => {
    const input = fixture();
    expect(
      resolveExecutionConfiguration(input, executionIdentity(), { modelProfileId: "backup" })
        .providerConnectionId,
    ).toBe("router");
    input.providers.forEach((p) => {
      p.enabled = false;
    });
    expect(() => resolveExecutionConfiguration(input, executionIdentity(), {})).toThrow(
      "available",
    );
    expect(() =>
      configurationView({}, executionConfigurationCatalog(input, input.agents[0]!)),
    ).not.toThrow();
  });

  it("preserves candidate order and rejects missing or same-connection candidates", () => {
    const input = fixture();
    expect(publicExecutionConfiguration(input).agents[0]!.fallback_model_profile_ids).toEqual([
      "backup",
    ]);
    for (const candidates of [["missing"], ["model-1"], ["backup", "backup"]]) {
      expect(() =>
        parseExecutionConfiguration({
          ...input,
          agents: [{ ...input.agents[0], fallback_model_profile_ids: candidates }],
        }),
      ).toThrow();
    }
  });

  it("does not send the original Provider's thinking parameters to a fallback", () => {
    const input = fixture();
    input.models[0]!.model = "deepseek-v4-flash";
    input.providers[0]!.enabled = false;
    expect(
      resolveExecutionConfiguration(input, executionIdentity(), { thinkingEffort: "max" }).model
        .thinking,
    ).toBeUndefined();
  });
});
