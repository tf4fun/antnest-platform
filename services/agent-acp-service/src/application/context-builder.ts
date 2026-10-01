import type { ResourceIdGenerator } from "../domain/resource-id.js";
import { DomainError } from "../domain/errors.js";
import { skillCommands, skillInvocation } from "../domain/skill-commands.js";
import type { RuntimePath } from "../domain/runtime-information.js";
import { withPlanTool } from "../domain/plan.js";
import type {
  ContentBlock,
  ModelMessage,
  ModelToolDefinition,
  RunExecutionSnapshot,
} from "../domain/types.js";
import type { RuntimeInformationPort } from "../ports/runtime-information.js";
import type { ToolCatalogPort } from "../ports/tools.js";
import { estimateMessages, estimateText, inputBudget } from "./context-budget.js";
import { runtimeContext } from "./runtime-context.js";
import type {
  ContextCheckpoint,
  ContextRepository,
  StoredContextMessage,
} from "../ports/context-repository.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";

export type ContextBuilderDependencies = {
  repository: ContextRepository;
  runtimeInformation: RuntimeInformationPort;
  tools: Pick<ToolCatalogPort, "list">;
  readSkill?: (
    binding: RunExecutionSnapshot["runtime"],
    path: RuntimePath,
    signal: AbortSignal,
  ) => Promise<string>;
  id: ResourceIdGenerator;
  now: () => Date;
};

export type PreparedRunContext = {
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  runtimeWorkspace: string;
};

export class ContextBuilder {
  public constructor(private readonly dependencies: ContextBuilderDependencies) {}

  public async build(
    sessionId: string,
    snapshot: RunExecutionSnapshot,
    ownershipSignal: AbortSignal,
  ): Promise<PreparedRunContext> {
    if (snapshot.executionSpec.skillInstructions.length !== 0) {
      throw new DomainError(
        "invalid_execution_configuration",
        "Legacy Skill instructions are unsupported",
      );
    }
    const information = await this.dependencies.runtimeInformation.read(snapshot, ownershipSignal);
    const tools =
      snapshot.executionSpec.configuration?.authorization.mode === "chat"
        ? []
        : withPlanTool(await this.dependencies.tools.list(snapshot, ownershipSignal));
    assertWorkerOwnership(ownershipSignal);
    const budget = inputBudget(snapshot, tools);
    const source = await withWorkerOwnership(ownershipSignal, () =>
      this.dependencies.repository.load(sessionId),
    );
    const newestUser = source.messages.findLast((message) => message.kind === "user_message");
    const invocation =
      newestUser?.kind === "user_message" ? skillInvocation(newestUser.content) : undefined;
    let expanded: ContentBlock[] | undefined;
    if (invocation !== undefined && newestUser?.kind === "user_message") {
      const commandName = `skill:${invocation.source}:${invocation.name}`;
      const skill = information.skills.find(
        (item) => item.source === invocation.source && item.name === invocation.name,
      );
      if (
        skill === undefined ||
        !skillCommands(information.skills).some((item) => item.name === commandName)
      )
        throw new DomainError(
          "skill_unavailable",
          "The selected Skill is no longer available; refresh the command menu",
        );
      if (this.dependencies.readSkill === undefined)
        throw new DomainError("skill_unavailable", "Skill content reading is unavailable");
      const body = await this.dependencies.readSkill(snapshot.runtime, skill.path, ownershipSignal);
      assertWorkerOwnership(ownershipSignal);
      expanded = newestUser.content.map((block, index) =>
        index === invocation.textIndex
          ? {
              type: "text",
              text: `Use the user-selected Skill ${JSON.stringify({ source: skill.source, name: skill.name, path: skill.path })} for this task. Skill guidance remains subject to the system instructions and existing tool authorization.\n\n<selected_skill>\n${body}\n</selected_skill>\n\nUser task:\n${invocation.task}`,
            }
          : block,
      );
    }
    const modelMessages = (message: StoredContextMessage) =>
      message === newestUser && expanded !== undefined
        ? [{ role: "user" as const, content: expanded }]
        : toModelMessages(message);
    const system = systemMessage(snapshot);
    system.content.push({
      type: "text",
      text: runtimeContext(information, Math.min(16384, Math.floor(budget / 4) * 4)),
    });
    const prefix: ModelMessage[] = [system];
    if (source.plan !== undefined)
      prefix.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Conversation plan at Run start (historical snapshot; later successful update_plan calls replace it):\n${JSON.stringify(source.plan)}`,
          },
        ],
      });
    const checkpoint = checkpointMessage(source.checkpoint);
    const history = source.messages.flatMap(modelMessages);
    const complete = [...prefix, ...(checkpoint === null ? [] : [checkpoint]), ...history];
    if (estimateMessages(complete) <= budget) {
      assertWorkerOwnership(ownershipSignal);
      return { messages: complete, tools, runtimeWorkspace: information.environment.workspace };
    }

    const systemCost = estimateMessages(prefix);
    const tailBudget = Math.max(1, Math.floor((budget - systemCost) * 0.55));
    const { dropped, kept } = keepNewest(source.messages, tailBudget, modelMessages);
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
          id: this.dependencies.id("checkpoint"),
          sessionId,
          throughSequence,
          summary,
          tokenCount: estimateText(summary),
          createdAt: this.dependencies.now(),
        }),
      );
    }

    const compacted = [
      ...prefix,
      ...(summary.length === 0 ? [] : [summaryMessage(summary)]),
      ...kept.flatMap(modelMessages),
    ];
    if (estimateMessages(compacted) > budget) {
      throw new DomainError(
        "context_budget_exhausted",
        "Conversation context does not fit the selected model context window",
      );
    }
    assertWorkerOwnership(ownershipSignal);
    return { messages: compacted, tools, runtimeWorkspace: information.environment.workspace };
  }
}

function systemMessage(snapshot: RunExecutionSnapshot): ModelMessage {
  return { role: "system", content: [{ type: "text", text: snapshot.executionSpec.systemPrompt }] };
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
      return [
        {
          role: "assistant",
          content: message.content,
          ...(message.thought === undefined ? {} : { thought: message.thought }),
        },
      ];
    case "environment_change":
      return [{ role: "system", content: message.content }];
    case "tool_exchange":
      return [
        {
          role: "assistant",
          content: message.assistant.content,
          toolCalls: message.assistant.toolCalls,
          ...(message.assistant.thought === undefined
            ? {}
            : { thought: message.assistant.thought }),
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
  modelMessages: (message: StoredContextMessage) => ModelMessage[] = toModelMessages,
): { dropped: StoredContextMessage[]; kept: StoredContextMessage[] } {
  let used = 0;
  let boundary = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    const cost = estimateMessages(modelMessages(message));
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
