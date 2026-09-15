import { describe, expect, it } from "vitest";
import {
  executionConfigurationCatalog,
  resolveExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { changeConfiguration, configurationView } from "../../src/domain/session-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import { v1Configuration, v2Configuration } from "../../src/transport/acp/configuration.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

function fixture() {
  const configuration = executionConfiguration();
  configuration.models[0]!.model = "deepseek-v4-flash";
  const catalog = executionConfigurationCatalog(configuration, configuration.agents[0]!);
  return { configuration, catalog };
}

describe("Session model and thinking selection", () => {
  it("publishes provider groups and supported thought levels through both ACP versions", () => {
    const { catalog } = fixture();
    const view = configurationView({}, catalog);
    for (const response of [v1Configuration(view), v2Configuration(view)]) {
      const model = response.configOptions.find((option) => option.category === "model");
      const groupKey = model !== undefined && "id" in model ? "group" : "groupId";
      expect(model?.type === "select" ? model.options : undefined).toEqual([
        {
          [groupKey]: "agent",
          name: "Agent",
          options: [{ value: "agent_default", name: "Agent default: Test model" }],
        },
        {
          [groupKey]: "DeepSeek",
          name: "DeepSeek",
          options: [
            { value: "profile:model-1", name: "Test model", description: "deepseek-v4-flash" },
          ],
        },
      ]);
      expect(
        response.configOptions.find((option) => option.category === "thought_level"),
      ).toMatchObject({
        currentValue: "default",
        options: [
          { value: "default" },
          { value: "off" },
          { value: "low" },
          { value: "high" },
          { value: "max" },
        ],
      });
      expect(JSON.stringify(response)).not.toContain("synthetic-provider-key");
      expect(JSON.stringify(response)).not.toContain("https://api.deepseek.com");
    }
  });

  it.each(["off", "low", "high", "max"] as const)(
    "persists %s and freezes it in the execution snapshot",
    (effort) => {
      const { configuration, catalog } = fixture();
      const overrides = changeConfiguration({}, "thinking_effort", effort, catalog);
      expect(overrides).toEqual({ thinkingEffort: effort });
      const input = {
        configuration,
        identity: executionIdentity(),
        overrides,
        accessRevision: "access-1",
        clientMcpRevisionId: "mcp-1",
        deadlineAt: new Date(0),
      };
      const snapshot = runSnapshot(input);
      expect(snapshot.executionSpec.model.thinking).toEqual({ protocol: "deepseek", effort });
      expect(snapshot.agentExecutionSpecDigest).not.toBe(
        runSnapshot({ ...input, overrides: {} }).agentExecutionSpecDigest,
      );
      expect(changeConfiguration(overrides, "thinking_effort", "default", catalog)).toEqual({});
    },
  );

  it("clears incompatible effort on model change without changing authorization", () => {
    const { configuration } = fixture();
    configuration.models.push({
      ...configuration.models[0]!,
      model_profile_id: "unknown",
      model: "custom-model",
    });
    const catalog = executionConfigurationCatalog(configuration, configuration.agents[0]!);
    const next = changeConfiguration(
      { thinkingEffort: "max", authorizationMode: "chat" },
      "model",
      "profile:unknown",
      catalog,
    );
    expect(next).toEqual({ modelProfileId: "unknown", authorizationMode: "chat" });
    expect(
      v1Configuration(configurationView(next, catalog)).configOptions.some(
        (option) => option.category === "thought_level",
      ),
    ).toBe(false);
    expect(() => changeConfiguration(next, "thinking_effort", "high", catalog)).toThrow();
    expect(() => changeConfiguration({}, "thinking_effort", "ultra", catalog)).toThrow();
  });

  it("does not advertise unknown models or silently execute an obsolete effort", () => {
    const { configuration } = fixture();
    configuration.models[0]!.model = "custom-model";
    const catalog = executionConfigurationCatalog(configuration, configuration.agents[0]!);
    expect(v1Configuration(configurationView({}, catalog)).configOptions).toHaveLength(2);
    expect(() =>
      resolveExecutionConfiguration(configuration, executionIdentity(), { thinkingEffort: "max" }),
    ).toThrow();
    expect(
      changeConfiguration({ thinkingEffort: "max" }, "thinking_effort", "default", catalog),
    ).toEqual({});
  });
});
