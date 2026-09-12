import { describe, expect, it } from "vitest";
import { planInput, planTool, withPlanTool } from "../../src/domain/plan.js";
import { ToolPreflight } from "../../src/application/tool-preflight.js";

describe("Structured plan", () => {
  it("uses complete lists including an explicit clear, with all standard states", () => {
    const entries = ["pending", "in_progress", "completed"].map((status, index) => ({
      content: `Step ${index}`,
      priority: ["high", "medium", "low"][index],
      status,
    }));
    expect(planInput.parse({ entries })).toEqual({ entries });
    expect(planInput.parse({ entries: [] })).toEqual({ entries: [] });
    expect(
      new ToolPreflight().inspect(
        [{ id: "call", name: "update_plan", arguments: { entries } }],
        [planTool],
      ).kind,
    ).toBe("ready");
  });
  it.each([
    {},
    { entries: "markdown list" },
    { entries: [{ content: "a", priority: "urgent", status: "pending" }] },
    { entries: [{ content: "a", priority: "high", status: "failed" }] },
    { entries: [{ content: "x".repeat(513), priority: "high", status: "pending" }] },
    {
      entries: Array.from({ length: 17 }, () => ({
        content: "a",
        priority: "low",
        status: "pending",
      })),
    },
  ])("rejects invalid or oversized input without inventing a plan: %j", (args) => {
    expect(planInput.safeParse(args).success).toBe(false);
    expect(
      new ToolPreflight().inspect(
        [{ id: "call", name: "update_plan", arguments: args }],
        [planTool],
      ).kind,
    ).toBe("rejected");
  });
  it("does not override a Runtime tool or mutate its catalog", () => {
    const remote = { ...planTool, source: "runtime" as const, sourceId: "runtime" };
    expect(() => withPlanTool([remote])).toThrow(/collision/i);
    const catalog = [{ ...remote, name: "read", modelName: "read" }];
    expect(withPlanTool(catalog)).toEqual([...catalog, planTool]);
    expect(catalog).toHaveLength(1);
  });
});
