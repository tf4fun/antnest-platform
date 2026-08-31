import { createHash } from "node:crypto";

import type { ContentBlock, ModelToolDefinition, RuntimeEffectState } from "../domain/types.js";
import type { SessionEvent, SessionEventPublisher } from "../ports/acp-application.js";
import type { ModelUsage } from "../ports/model.js";
import type { RunEventPort } from "../ports/run-events.js";
import type { RunEventRepository } from "../ports/run-event-repository.js";

const MAX_RESULT_SUMMARY_CHARACTERS = 4_096;

export type DurableRunEventsDependencies = {
  repository: RunEventRepository;
  publish: SessionEventPublisher["publish"];
  id: () => string;
  now: () => Date;
  contextSize: number;
};

export class DurableRunEvents implements RunEventPort {
  public constructor(private readonly dependencies: DurableRunEventsDependencies) {}

  public async toolStarted(
    runId: string,
    toolCallId: string,
    tool: ModelToolDefinition,
    arguments_: { [key: string]: unknown },
  ): Promise<void> {
    const event = await this.dependencies.repository.startToolAttempt({
      id: this.dependencies.id(),
      runId,
      toolCallId,
      tool,
      requestDigest: digest(arguments_),
      createdAt: this.dependencies.now(),
    });
    await this.publish(event);
  }

  public async toolFinished(
    runId: string,
    toolCallId: string,
    status: "completed" | "failed" | "cancelled",
    content: ContentBlock[],
    runtimeEffectState: RuntimeEffectState,
  ): Promise<void> {
    const event = await this.dependencies.repository.finishToolAttempt({
      id: this.dependencies.id(),
      runId,
      toolCallId,
      status,
      content,
      resultSummary: summarize(content),
      runtimeEffectState,
      createdAt: this.dependencies.now(),
    });
    await this.publish(event);
  }

  public async agentMessage(runId: string, content: ContentBlock[]): Promise<void> {
    const event = await this.dependencies.repository.appendAgentMessage({
      id: this.dependencies.id(),
      runId,
      content,
      createdAt: this.dependencies.now(),
    });
    await this.publish(event);
  }

  public async usage(runId: string, usage: ModelUsage): Promise<void> {
    const event = await this.dependencies.repository.appendUsage({
      id: this.dependencies.id(),
      runId,
      usage,
      contextSize: this.dependencies.contextSize,
      createdAt: this.dependencies.now(),
    });
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
