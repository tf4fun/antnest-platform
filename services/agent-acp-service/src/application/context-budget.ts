import { DomainError } from "../domain/errors.js";
import type {
  ModelMessage,
  ModelSpec,
  ModelToolDefinition,
  RunExecutionSnapshot,
} from "../domain/types.js";
import { createTokenEstimator } from "./token-estimator.js";
import { tokenCalibrationRatio } from "./token-calibration.js";

const INPUT_RESERVE_TOKENS = 256;
const SAFETY_MARGIN = 1.05;

export function inputBudget(snapshot: RunExecutionSnapshot, tools: ModelToolDefinition[]): number {
  const model = snapshot.executionSpec.model;
  const available = model.contextWindow - model.maxOutputTokens - INPUT_RESERVE_TOKENS;
  if (available <= 0)
    throw new DomainError(
      "invalid_context_budget",
      "Model output reservation leaves no input context capacity",
    );
  const budget =
    Math.floor(available / (SAFETY_MARGIN * tokenCalibrationRatio(snapshot))) -
    createTokenEstimator(model).estimateTools(tools);
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
  if (
    createTokenEstimator(snapshot.executionSpec.model).estimateMessages(messages) >
    inputBudget(snapshot, tools)
  ) {
    throw new DomainError(
      "context_budget_exhausted",
      "Model input exceeds the selected context window",
    );
  }
}

export function estimateMessages(
  messages: ModelMessage[],
  model?: Pick<ModelSpec, "tokenizer" | "model">,
): number {
  return createTokenEstimator(model).estimateMessages(messages);
}

export function estimateText(text: string, model?: Pick<ModelSpec, "tokenizer" | "model">): number {
  return createTokenEstimator(model).estimateText(text);
}
