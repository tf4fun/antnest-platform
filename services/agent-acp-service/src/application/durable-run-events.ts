import { createHash } from "node:crypto";

import type { ContentBlock, ModelToolDefinition, ToolEffectState } from "../domain/types.js";
import { describeTool, type ToolResultPresentation } from "../domain/tool-presentation.js";
import type { SessionEvent, SessionEventPublisher } from "../ports/acp-application.js";
import type { ModelUsage } from "../ports/model.js";
import type { ModelToolCall } from "../ports/model.js";
import type { RunEventPort } from "../ports/run-events.js";
import type { RunEventRepository } from "../ports/run-event-repository.js";
import { planResult, planTool, type PlanEntry } from "../domain/plan.js";

const MAX_RESULT_SUMMARY_CHARACTERS = 4_096;

export type DurableRunEventsDependencies = {
  repository: RunEventRepository;
  publish: SessionEventPublisher["publish"];
  id: () => string;
  now: () => Date;
  contextSize: number;
  runtimeWorkspace?: string;
};

export class RunEventPersistenceError extends Error {
  public constructor(operation: string, cause: unknown) {
    super(`Run event persistence failed during ${operation}`, { cause });
    this.name = "RunEventPersistenceError";
  }
}

export class DurableRunEvents implements RunEventPort {
  public constructor(private readonly dependencies: DurableRunEventsDependencies) {}

  public async updatePlan(
    runId: string,
    call: ModelToolCall,
    entries: PlanEntry[],
  ): Promise<boolean> {
    const events: Parameters<RunEventRepository["appendPlan"]>[0]["events"] = [
      { kind: "plan", entries },
      {
        kind: "tool_call",
        initial: true,
        toolCallId: call.id,
        title: "Update plan",
        toolKind: "other",
        modelName: planTool.modelName,
        arguments: call.arguments,
        status: "completed",
        content: planResult,
      },
    ];
    const applied = await this.persist("plan", () =>
      this.dependencies.repository.appendPlan({
        id: digest([runId, call.id, "plan"]),
        runId,
        events,
        createdAt: this.dependencies.now(),
      }),
    );
    if (applied) for (const event of events) await this.publish(event);
    return applied;
  }

  public async toolProgress(
    runId: string,
    toolCallId: string,
    content: ContentBlock[],
  ): Promise<void> {
    const event = await this.persist("Tool progress", () =>
      this.dependencies.repository.appendToolProgress({
        id: this.dependencies.id(),
        runId,
        toolCallId,
        content,
        createdAt: this.dependencies.now(),
      }),
    );
    await this.publish(event);
  }

  public async toolStarted(
    runId: string,
    toolCallId: string,
    tool: ModelToolDefinition,
    arguments_: { [key: string]: unknown },
  ): Promise<void> {
    const event = await this.persist("tool start", () =>
      this.dependencies.repository.startToolAttempt({
        id: this.dependencies.id(),
        runId,
        toolCallId,
        tool,
        presentation: describeTool(tool, arguments_, this.dependencies.runtimeWorkspace),
        arguments: arguments_,
        requestDigest: digest(arguments_),
        createdAt: this.dependencies.now(),
      }),
    );
    await this.publish(event);
  }

  public async toolRejected(runId: string, call: ModelToolCall, message: string): Promise<void> {
    const event = await this.persist("Tool rejection", () =>
      this.dependencies.repository.appendRejectedToolCall({
        id: this.dependencies.id(),
        runId,
        call,
        message,
        createdAt: this.dependencies.now(),
      }),
    );
    await this.publish(event);
  }

  public async toolFinished(
    runId: string,
    toolCallId: string,
    status: "completed" | "failed" | "cancelled",
    content: ContentBlock[],
    toolEffectState: ToolEffectState,
    presentation?: ToolResultPresentation,
  ): Promise<void> {
    const event = await this.persist("Tool finish", () =>
      this.dependencies.repository.finishToolAttempt({
        id: this.dependencies.id(),
        runId,
        toolCallId,
        status,
        content,
        resultSummary: summarize(content),
        toolEffectState,
        ...presentation,
        createdAt: this.dependencies.now(),
      }),
    );
    await this.publish(event);
  }

  public async agentMessage(
    runId: string,
    content: ContentBlock[],
    toolCalls?: ModelToolCall[],
    responseId?: string,
  ): Promise<void> {
    const event = await this.persist("agent message", () =>
      this.dependencies.repository.appendAgentMessage({
        id: this.dependencies.id(),
        runId,
        content,
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(responseId === undefined ? {} : { responseId }),
        createdAt: this.dependencies.now(),
      }),
    );
    if (content.length > 0) {
      await this.publish(event);
    }
  }

  public async agentThought(
    runId: string,
    content: ContentBlock[],
    responseId?: string,
  ): Promise<void> {
    const event = await this.persist("agent thought", () =>
      this.dependencies.repository.appendAgentThought({
        id: this.dependencies.id(),
        runId,
        content,
        ...(responseId === undefined ? {} : { responseId }),
        createdAt: this.dependencies.now(),
      }),
    );
    await this.publish(event);
  }

  public async usage(runId: string, usage: ModelUsage): Promise<void> {
    const event = await this.persist("usage", () =>
      this.dependencies.repository.appendUsage({
        id: this.dependencies.id(),
        runId,
        usage,
        contextSize: this.dependencies.contextSize,
        createdAt: this.dependencies.now(),
      }),
    );
    await this.publish(event);
  }

  private publish(event: SessionEvent): Promise<void> {
    try {
      void this.dependencies.publish(event).catch(() => {
        // The durable event is authoritative; reconnect and replay repair delivery.
      });
    } catch {
      // The durable event is authoritative; reconnect and replay repair delivery.
    }
    return Promise.resolve();
  }

  private async persist<Result>(
    operation: string,
    persist: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await persist();
    } catch (error) {
      throw new RunEventPersistenceError(operation, error);
    }
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function summarize(content: ContentBlock[]): ContentBlock[] {
  const serialized = JSON.stringify(content);
  if (serialized.length <= MAX_RESULT_SUMMARY_CHARACTERS) {
    return structuredClone(content);
  }
  return [
    {
      type: "text",
      text: `${serialized.slice(0, MAX_RESULT_SUMMARY_CHARACTERS)}\n[Result summary truncated]`,
    },
  ];
}
