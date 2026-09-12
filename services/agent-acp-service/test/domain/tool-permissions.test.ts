import { describe, expect, it } from "vitest";
import { parsePermissionDecision, permissionRule } from "../../src/domain/tool-permissions.js";
import { toolPermission } from "../../src/domain/session-configuration.js";

const tool = { source: "runtime" as const, sourceId: "runtime", name: "read" };
describe("Tool permission decisions", () => {
  for (const decision of ["allow_once", "allow_always", "reject_once", "reject_always"] as const) {
    it(`accepts offered ${decision}`, () => {
      expect(
        parsePermissionDecision({ outcome: { outcome: "selected", optionId: decision } }),
      ).toBe(decision);
    });
  }
  for (const response of [
    null,
    {},
    { outcome: "allow_once" },
    { outcome: { outcome: "selected" } },
    { outcome: { outcome: "selected", optionId: "other" } },
    { outcome: { outcome: "custom", optionId: "allow_once" } },
    { outcome: { outcome: "cancelled" } },
  ]) {
    it(`does not authorize ${JSON.stringify(response)}`, () => {
      expect(parsePermissionDecision(response)).toBe("cancelled");
    });
  }
  it("only always yields a scoped rule", () => {
    expect(permissionRule(tool, "allow_once")).toBeUndefined();
    expect(permissionRule(tool, "cancelled")).toBeUndefined();
    expect(permissionRule(tool, "allow_always")).toEqual({
      source: "runtime",
      sourceId: "runtime",
      toolName: "read",
      decision: "allow",
    });
    expect(permissionRule(tool, "reject_always")?.decision).toBe("deny");
  });
  it("uses only explicit non-conflicting read-only hints for Smart Approve", () => {
    const policy = { mode: "smart_approve" as const, toolRules: [] };
    expect(toolPermission(policy, tool)).toBe("ask");
    expect(toolPermission(policy, { ...tool, annotations: { readOnlyHint: true } })).toBe("allow");
    expect(
      toolPermission(policy, {
        ...tool,
        annotations: { readOnlyHint: true, destructiveHint: true },
      }),
    ).toBe("ask");
    expect(
      toolPermission(
        { ...policy, mode: "approve" },
        { ...tool, annotations: { readOnlyHint: true } },
      ),
    ).toBe("ask");
    expect(
      toolPermission(
        { ...policy, toolRules: [permissionRule(tool, "reject_always")!] },
        { ...tool, annotations: { readOnlyHint: true } },
      ),
    ).toBe("deny");
  });
});
