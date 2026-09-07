import { DomainError } from "../domain/errors.js";
import type { ModelMessage, ModelToolDefinition, RunExecutionSnapshot } from "../domain/types.js";

const INPUT_RESERVE_TOKENS = 256;

export function inputBudget(snapshot: RunExecutionSnapshot, tools: ModelToolDefinition[]): number {
  const model = snapshot.executionSpec.model;
  const available = model.contextWindow - model.maxOutputTokens - INPUT_RESERVE_TOKENS;
  if (available <= 0)
    throw new DomainError(
      "invalid_context_budget",
      "Model output reservation leaves no input context capacity",
    );
  const budget = available - estimateText(JSON.stringify(tools));
  if (budget <= 0)
    throw new DomainError(
      "context_budget_exhausted",
      "Tool definitions leave no input context capacity",
    );
  return budget;
}

export function assertModelInputBudget(
  snapshot: RunExecutionSnapshot,
  tools: ModelToolDefinition[],
  messages: ModelMessage[],
): void {
  if (estimateMessages(messages) > inputBudget(snapshot, tools)) {
    throw new DomainError(
      "context_budget_exhausted",
      "Model input exceeds the selected context window",
    );
  }
}

export function estimateMessages(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateText(JSON.stringify(message)) + 4, 0);
}

export function estimateText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
