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
import { compactModelContext, type CompactionComplete } from "./context-compaction.js";
import { seedTokenCalibration } from "./token-calibration.js";
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
    runId: string,
    options?: { complete?: CompactionComplete },
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
    const calibrations = await withWorkerOwnership(ownershipSignal, async () => {
      const compaction = snapshot.executionSpec.compactionModel;
      const candidate =
        compaction === undefined
          ? undefined
          : {
              ...snapshot,
              modelProfileId: compaction.modelProfileId,
              providerConnectionId: compaction.providerConnectionId,
              executionSpec: { ...snapshot.executionSpec, model: compaction.model },
            };
      return {
        ratio: (await this.dependencies.repository.loadCalibration?.(snapshot)) ?? 1,
        candidateRatio:
          candidate === undefined
            ? undefined
            : ((await this.dependencies.repository.loadCalibration?.(candidate)) ?? 1),
        candidate,
      };
    });
    seedTokenCalibration(snapshot, calibrations.ratio);
    if (calibrations.candidate !== undefined && calibrations.candidateRatio !== undefined)
      seedTokenCalibration(calibrations.candidate, calibrations.candidateRatio);
    const budget = inputBudget(snapshot, tools);
    const source = await withWorkerOwnership(ownershipSignal, () =>
      this.dependencies.repository.load(sessionId),
    );
    const storedSequences = new Set(source.messages.map((message) => message.sequence));
    for (const entry of source.pinned ?? []) {
      if (entry.id === undefined || !storedSequences.has(entry.sequence)) continue;
      const current = source.messages.find((message) => message.sequence === entry.sequence);
      if (current !== undefined && current.id === undefined) current.id = entry.id;
    }
    const stream: StoredContextMessage[] = [
      ...(source.pinned ?? []).filter((entry) => !storedSequences.has(entry.sequence)),
      ...source.messages,
    ];
    const pinnedSequences = new Set((source.pinned ?? []).map((entry) => entry.sequence));
    const pinnedIndexes = new Set<number>();
    for (let index = 0; index < stream.length - source.messages.length; index += 1)
      pinnedIndexes.add(index);
    stream.forEach((message, index) => {
      if (pinnedSequences.has(message.sequence)) pinnedIndexes.add(index);
    });
    const firstUserStored = stream.findIndex((message) => message.kind === "user_message");
    if (firstUserStored !== -1) pinnedIndexes.add(firstUserStored);
    const pinnedMessageIds = [...pinnedIndexes]
      .sort((left, right) => left - right)
      .map((index) => stream[index]?.id)
      .filter((id): id is string => id !== undefined);
    const newestUser = stream.findLast((message) => message.kind === "user_message");
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
      text: runtimeContext(
        information,
        Math.min(16384, Math.floor(budget / 4)),
        (text) => estimateText(text, snapshot.executionSpec.model),
        budget,
      ),
    });
    const prefix: ModelMessage[] = [system];
    if (source.plan !== undefined)
      prefix.push({
        role: "system",
        content: [
          {
            type: "text",
            text: `Conversation plan at Run start (historical snapshot; later successful update_plan calls replace it):\n${JSON.stringify(source.plan)}`,
          },
        ],
      });
    const checkpoint = checkpointMessage(source.checkpoint);
    const estimatorModel = snapshot.executionSpec.model;
    const complete: ModelMessage[] = [];
    for (const entry of prefix) complete.push(entry);
    if (checkpoint !== null) complete.push(checkpoint);
    const modelIndexByStored: number[][] = stream.map(() => []);
    stream.forEach((message, storedIndex) => {
      for (const modelMessage of modelMessages(message)) {
        modelIndexByStored[storedIndex]!.push(complete.length);
        complete.push(modelMessage);
      }
    });
    if (estimateMessages(complete, estimatorModel) <= budget) {
      assertWorkerOwnership(ownershipSignal);
      return { messages: complete, tools, runtimeWorkspace: information.environment.workspace };
    }

    const compacted = await compactModelContext({
      snapshot,
      messages: complete,
      tools,
      signal: ownershipSignal,
      ...(options?.complete === undefined ? {} : { complete: options.complete }),
    });
    assertWorkerOwnership(ownershipSignal);

    const dropped = new Set(compacted.droppedIndexes);
    let boundary = -1;
    for (let storedIndex = 0; storedIndex < stream.length; storedIndex += 1) {
      if (pinnedIndexes.has(storedIndex)) continue;
      const indexes = modelIndexByStored[storedIndex]!;
      if (indexes.length > 0 && indexes.every((index) => dropped.has(index))) {
        boundary = storedIndex;
      } else {
        break;
      }
    }
    if (boundary !== -1) {
      const lastDropped = stream[boundary];
      const throughSequence = lastDropped?.endSequence ?? lastDropped?.sequence;
      if (throughSequence === undefined) {
        throw new DomainError("context_compaction_failed", "Compaction boundary is missing");
      }
      await withWorkerOwnership(ownershipSignal, () =>
        this.dependencies.repository.saveCheckpoint({
          id: this.dependencies.id("checkpoint"),
          sessionId,
          runId,
          throughSequence,
          summary: compacted.summary,
          tokenCount: estimateText(compacted.summary, estimatorModel),
          createdAt: this.dependencies.now(),
          compactionPromptVersion: compacted.promptVersion,
          ...(pinnedMessageIds.length === 0 ? {} : { pinnedMessageIds }),
        }),
      );
    }

    assertWorkerOwnership(ownershipSignal);
    return {
      messages: compacted.messages,
      tools,
      runtimeWorkspace: information.environment.workspace,
    };
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
