import type { ModelMessage, ModelToolDefinition } from "../domain/types.js";

export interface TokenEstimator {
  estimateText(text: string): number;
  estimateImage(width?: number, height?: number): number;
  estimateMessages(messages: ModelMessage[]): number;
  estimateTools(tools: ModelToolDefinition[]): number;
}
