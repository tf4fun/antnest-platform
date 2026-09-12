import { z } from "zod";
import { DomainError } from "./errors.js";
import type { ContentBlock, JsonObject, ModelToolDefinition } from "./types.js";

export const planInput = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        content: z.string().min(1).max(512),
        priority: z.enum(["high", "medium", "low"]),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .max(16),
});
export type PlanEntry = z.infer<typeof planInput>["entries"][number];

export const planTool: ModelToolDefinition = {
  source: "agent",
  sourceId: "plan",
  name: "update_plan",
  modelName: "update_plan",
  title: "Update plan",
  annotations: { readOnlyHint: false },
  description:
    "For multi-step tasks, share a plan and update it as work progresses. Send the complete ordered entries every time, not just changed entries. Use an empty list to clear it. Only mark work completed when actually done. Simple replies do not need a plan.",
  inputSchema: z.toJSONSchema(planInput) as JsonObject,
};

export const planResult: ContentBlock[] = [{ type: "text", text: "Plan updated." }];

export function withPlanTool(tools: ModelToolDefinition[]): ModelToolDefinition[] {
  if (tools.some((tool) => tool.modelName === planTool.modelName)) {
    throw new DomainError("tool_name_collision", "Tool name collision for update_plan");
  }
  return [...tools, planTool];
}
