import { expect, it, vi } from "vitest";
import { RunToolAuthorization } from "../../src/application/run-tool-authorization.js";
import { skillDiscoveryTools } from "../../src/domain/skill-discovery.js";
import { snapshot } from "../support/fixtures.js";

it.each(["find_skill", "load_skill"])(
  "%s obeys deny rules and ordinary approval without granting publication",
  async (name) => {
    const tool = skillDiscoveryTools.find((item) => item.name === name)!;
    const request = vi.fn(() =>
      Promise.resolve({ decision: "allow_once" as const, reason: "user_choice" }),
    );
    const gate = new RunToolAuthorization({ request });
    const frozen = snapshot();
    frozen.executionSpec.configuration = {
      modelProfileId: frozen.modelProfileId,
      authorizationRevision: 1,
      digest: "a".repeat(64),
      authorization: { mode: "smart_approve", toolRules: [] },
    };
    const input = {
      runId: "run-1",
      sessionId: "session-1",
      snapshot: frozen,
      context: [],
      signal: new AbortController().signal,
      authoritySignal: new AbortController().signal,
    };
    const prepared = { tool, call: { id: "tool-1", name, arguments: {} } };
    expect(await gate.check(input, prepared)).toBeNull();
    expect(request).toHaveBeenCalledTimes(name === "load_skill" ? 1 : 0);
    request.mockClear();
    frozen.executionSpec.configuration.authorization.toolRules = [
      { source: "agent", sourceId: "skill_registry", toolName: name, decision: "deny" },
    ];
    expect(await gate.check(input, prepared)).toContain("disabled");
    expect(request).not.toHaveBeenCalled();
    frozen.executionSpec.configuration.authorization = { mode: "approve", toolRules: [] };
    expect(await gate.check(input, prepared)).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  },
);
