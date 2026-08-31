import { DomainError } from "../domain/errors.js";
import type { ContentBlock, ModelMessage, RunExecutionSnapshot } from "../domain/types.js";
import type {
  ContextCheckpoint,
  ContextRepository,
  StoredContextMessage,
} from "../ports/context-repository.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";

const INPUT_RESERVE_TOKENS = 256;

export type ContextBuilderDependencies = {
  repository: ContextRepository;
  id: () => string;
  now: () => Date;
};

export class ContextBuilder {
  public constructor(private readonly dependencies: ContextBuilderDependencies) {}

  public async build(
    sessionId: string,
    snapshot: RunExecutionSnapshot,
    ownershipSignal: AbortSignal,
  ): Promise<ModelMessage[]> {
    const source = await withWorkerOwnership(ownershipSignal, () =>
      this.dependencies.repository.load(sessionId),
    );
    const system = systemMessage(snapshot);
    const checkpoint = checkpointMessage(source.checkpoint);
    const history = source.messages.flatMap(toModelMessages);
    const complete = [system, ...(checkpoint === null ? [] : [checkpoint]), ...history];
    const budget = inputBudget(snapshot);
    if (estimateMessages(complete) <= budget) {
      assertWorkerOwnership(ownershipSignal);
      return complete;
    }

    const systemCost = estimateMessages([system]);
    const tailBudget = Math.max(1, Math.floor((budget - systemCost) * 0.55));
    const { dropped, kept } = keepNewest(source.messages, tailBudget);
    if (kept.length === 0) {
      throw new DomainError(
        "context_budget_exhausted",
        "The newest user request does not fit the selected model context window",
      );
    }

    const summary = boundedSummary(
      source.checkpoint,
      dropped,
      Math.max(256, Math.floor((budget - systemCost) * 4 * 0.3)),
    );
    if (dropped.length > 0) {
      const lastDropped = dropped.at(-1);
      const throughSequence =
        lastDropped === undefined ? undefined : (lastDropped.endSequence ?? lastDropped.sequence);
      if (throughSequence === undefined) {
        throw new DomainError("context_compaction_failed", "Compaction boundary is missing");
      }
      await withWorkerOwnership(ownershipSignal, () =>
        this.dependencies.repository.saveCheckpoint({
          id: this.dependencies.id(),
          sessionId,
          throughSequence,
          summary,
          tokenCount: estimateText(summary),
          createdAt: this.dependencies.now(),
        }),
      );
    }

    const compacted = [
      system,
      ...(summary.length === 0 ? [] : [summaryMessage(summary)]),
      ...kept.flatMap(toModelMessages),
    ];
    if (estimateMessages(compacted) > budget) {
      throw new DomainError(
        "context_budget_exhausted",
        "Conversation context does not fit the selected model context window",
      );
    }
    assertWorkerOwnership(ownershipSignal);
    return compacted;
  }
}

function inputBudget(snapshot: RunExecutionSnapshot): number {
  const model = snapshot.executionSpec.model;
  const budget = model.contextWindow - model.maxOutputTokens - INPUT_RESERVE_TOKENS;
  if (budget <= 0) {
    throw new DomainError(
      "invalid_context_budget",
      "Model output reservation leaves no input context capacity",
    );
  }
  return budget;
}

function systemMessage(snapshot: RunExecutionSnapshot): ModelMessage {
  const skills = snapshot.executionSpec.skillInstructions
    .map((skill) => `## Skill ${skill.skillKey}@${skill.version}\n${skill.instructions}`)
    .join("\n\n");
  const text =
    skills.length === 0
      ? snapshot.executionSpec.systemPrompt
      : `${snapshot.executionSpec.systemPrompt}\n\n# Available skill instructions\n${skills}`;
  return { role: "system", content: [{ type: "text", text }] };
}

function checkpointMessage(checkpoint: ContextCheckpoint | null): ModelMessage | null {
  if (checkpoint === null || checkpoint.summary.length === 0) {
    return null;
  }
  return summaryMessage(checkpoint.summary);
}

function summaryMessage(summary: string): ModelMessage {
  return {
    role: "system",
    content: [{ type: "text", text: `Earlier conversation summary:\n${summary}` }],
  };
}

function toModelMessages(message: StoredContextMessage): ModelMessage[] {
  switch (message.kind) {
    case "user_message":
      return [{ role: "user", content: message.content }];
    case "agent_message":
      return [{ role: "assistant", content: message.content }];
    case "environment_change":
      return [{ role: "system", content: message.content }];
    case "tool_exchange":
      return [
        {
          role: "assistant",
          content: message.assistant.content,
          toolCalls: message.assistant.toolCalls,
        },
        ...message.results.map((result) => ({
          role: "tool" as const,
          toolCallId: result.toolCallId,
          content: result.content,
        })),
      ];
  }
}

function keepNewest(
  messages: StoredContextMessage[],
  budget: number,
): { dropped: StoredContextMessage[]; kept: StoredContextMessage[] } {
  let used = 0;
  let boundary = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    const cost = estimateMessages(toModelMessages(message));
    if (used > 0 && used + cost > budget) {
      break;
    }
    used += cost;
    boundary = index;
  }
  return { dropped: messages.slice(0, boundary), kept: messages.slice(boundary) };
}

function boundedSummary(
  checkpoint: ContextCheckpoint | null,
  dropped: StoredContextMessage[],
  maxCharacters: number,
): string {
  const entries = [
    ...(checkpoint === null || checkpoint.summary.length === 0
      ? []
      : [`[previous_summary] ${checkpoint.summary}`]),
    ...dropped.map(summaryEntry),
  ];
  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const cost = entry.length + (kept.length === 0 ? 0 : 1);
    if (cost > maxCharacters - used) {
      continue;
    }
    kept.unshift(entry);
    used += cost;
  }
  const omitted = kept.length < entries.length ? "[Earlier complete entries omitted]" : "";
  return [omitted, ...kept].filter((entry) => entry.length > 0).join("\n");
}

function summaryEntry(message: StoredContextMessage): string {
  if (message.kind === "tool_exchange") {
    return (
      `[tool_exchange] assistant=${contentText(message.assistant.content)} ` +
      `calls=${JSON.stringify(message.assistant.toolCalls)} ` +
      `results=${message.results.map((result) => `${result.toolCallId}:${contentText(result.content)}`).join(" | ")}`
    );
  }
  return `[${message.kind}] ${contentText(message.content)}`;
}

function contentText(content: ContentBlock[]): string {
  return content
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : `[${block.type}]`,
    )
    .join(" ");
}

function estimateMessages(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateText(JSON.stringify(message)) + 4, 0);
}

function estimateText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
