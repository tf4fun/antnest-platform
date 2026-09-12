import { describe, expect, it } from "vitest";
import {
  configurationView,
  changeConfiguration,
  toolPermission,
} from "../../src/domain/session-configuration.js";

const model = {
  modelProfileId: "p1",
  revisionId: "r1",
  displayName: "One",
  model: "model-one",
  contextWindow: 32000,
  maxOutputTokens: 2048,
  supportsImages: false,
};
const catalog = {
  models: [model],
  defaultModel: { ...model, available: true },
  defaultAuthorization: { mode: "auto" as const, toolRules: [] },
  authorizationRevision: 1,
};

describe("Session configuration", () => {
  it("distinguishes inheritance from explicit same-model selection", () => {
    const inherited = configurationView({}, catalog);
    expect(inherited.modelId).toBe("agent_default");
    expect(inherited.modeId).toBe("auto");
    const selected = changeConfiguration({}, "model", "profile:p1", catalog);
    expect(selected).toEqual({ modelProfileId: "p1" });
    expect(changeConfiguration(selected, "model", "agent_default", catalog)).toEqual({});
    expect(configurationView(selected, catalog).modelId).toBe("profile:p1");
  });
  it("rejects unknown options, booleans, models and modes without changing other overrides", () => {
    for (const [id, value] of [
      ["model", "p1"],
      ["model", true],
      ["mode", "root"],
      ["other", "auto"],
    ] as const)
      expect(() => changeConfiguration({}, id, value, catalog)).toThrow();
    expect(changeConfiguration({ modelProfileId: "p1" }, "mode", "chat", catalog)).toEqual({
      modelProfileId: "p1",
      authorizationMode: "chat",
    });
  });
  it("retains an unavailable selection visibly so the owner can repair it", () => {
    const view = configurationView({ modelProfileId: "gone" }, catalog);
    expect(view.modelId).toBe("profile:gone");
    expect(view.models.find((m) => m.id === view.modelId)?.name).toContain("Unavailable");
    expect(() => changeConfiguration({}, "model", view.modelId, catalog)).toThrow();
  });
  it("never treats missing approval as permission, or Chat as read-only shell access", () => {
    const tool = { source: "runtime" as const, sourceId: "runtime", name: "bash" };
    expect(toolPermission({ mode: "chat", toolRules: [] }, tool)).toBe("deny");
    expect(toolPermission({ mode: "auto", toolRules: [] }, tool)).toBe("allow");
    expect(toolPermission({ mode: "approve", toolRules: [] }, tool)).toBe("ask");
    expect(toolPermission({ mode: "smart_approve", toolRules: [] }, tool)).toBe("ask");
    const rule = {
      source: "runtime" as const,
      sourceId: "runtime",
      toolName: "bash",
      decision: "allow" as const,
    };
    expect(toolPermission({ mode: "approve", toolRules: [rule] }, tool)).toBe("allow");
    expect(
      toolPermission({ mode: "approve", toolRules: [rule] }, { ...tool, sourceId: "other" }),
    ).toBe("ask");
  });
});
