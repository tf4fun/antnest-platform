import { z } from "zod";
import type { Authorization } from "./session-configuration.js";
import type { ModelToolDefinition } from "./types.js";

export const permissionChoices = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow in this session", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject in this session", kind: "reject_always" },
] as const;
export type PermissionDecision = (typeof permissionChoices)[number]["optionId"] | "cancelled";
const selected = z.object({
  outcome: z.object({
    outcome: z.literal("selected"),
    optionId: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
  }),
});

export function parsePermissionDecision(response: unknown): PermissionDecision {
  const parsed = selected.safeParse(response);
  return parsed.success ? parsed.data.outcome.optionId : "cancelled";
}

export function permissionRule(
  tool: Pick<ModelToolDefinition, "source" | "sourceId" | "name">,
  decision: PermissionDecision,
): Authorization["toolRules"][number] | undefined {
  if (tool.source === "client" || (decision !== "allow_always" && decision !== "reject_always"))
    return undefined;
  return {
    source: tool.source,
    sourceId: tool.sourceId,
    toolName: tool.name,
    decision: decision === "allow_always" ? "allow" : "deny",
  };
}
