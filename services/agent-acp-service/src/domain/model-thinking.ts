import { z } from "zod";
import { DomainError } from "./errors.js";

export const thinkingEffortSchema = z.enum(["off", "low", "high", "max"]);
export type ThinkingEffort = z.infer<typeof thinkingEffortSchema>;
export type ModelThinking = { protocol: "deepseek"; effort: ThinkingEffort };

// Protocol capabilities, not pricing/context metadata. Unknown models opt out.
const deepseekModels = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
]);

export function thinkingEfforts(provider: string, model: string): readonly ThinkingEffort[] {
  return provider === "deepseek" && deepseekModels.has(model) ? thinkingEffortSchema.options : [];
}

export function resolveThinking(
  provider: string,
  model: string,
  effort: ThinkingEffort | undefined,
): ModelThinking | undefined {
  if (effort === undefined) return undefined;
  if (!thinkingEfforts(provider, model).includes(effort))
    throw new DomainError(
      "invalid_configuration",
      "Selected model no longer supports this thinking effort; reset the Session thinking setting",
    );
  return { protocol: "deepseek", effort };
}
