import { describe, expect, it, vi } from "vitest";

import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import { DurableRunEvents } from "../../src/application/durable-run-events.js";
import type { PlanEntry } from "../../src/domain/plan.js";
import type { ResourceIdGenerator } from "../../src/domain/resource-id.js";
import type { ModelToolDefinition } from "../../src/domain/types.js";
import type { SessionEvent, SessionEventPublisher } from "../../src/ports/acp-application.js";
import type { ModelUsage } from "../../src/ports/model.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";

const cases = [
  { operation: "updatePlan", repositoryMethod: "appendPlan" },
  { operation: "toolProgress", repositoryMethod: "appendToolProgress" },
  { operation: "toolStarted", repositoryMethod: "startToolAttempt" },
  { operation: "toolRejected", repositoryMethod: "appendRejectedToolCall" },
  { operation: "toolFinished", repositoryMethod: "finishToolAttempt" },
  { operation: "agentMessage", repositoryMethod: "appendAgentMessage" },
  { operation: "agentThought", repositoryMethod: "appendAgentThought" },
  { operation: "usage", repositoryMethod: "appendUsage" },
] as const;

type Operation = (typeof cases)[number]["operation"];
type WriteMethod = Exclude<keyof RunEventRepository, "interruptToolAttempts">;
type WriteInput = Parameters<RunEventRepository[WriteMethod]>[0];

describe("DurableRunEvents retry inputs", () => {
  it.each(cases)(
    "retries $operation with one immutable persistence input and publishes only after success",
    async ({ operation, repositoryMethod }) => {
      const ownership = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const firstFailure = new Error("first persistence attempt failed");
      const sourceDate = new Date("2026-10-21T00:00:00.000Z");
      const inputs: WriteInput[] = [];
      const snapshots: WriteInput[] = [];
      const write = vi.fn(async (input: WriteInput) => {
        inputs.push(input);
        snapshots.push(structuredClone(input));
        if (snapshots.length === 1) {
          entered.resolve();
          await release.promise;
          throw firstFailure;
        }
      });
      const receipt = persistedEvent(operation);
      const repository = eventRepository(write, receipt);
      const publish = vi.fn<SessionEventPublisher["publish"]>(() => Promise.resolve());
      let generatedIds = 0;
      const id = vi.fn<ResourceIdGenerator>(() => `message-${++generatedIds}`);
      const now = vi.fn(() => sourceDate);
      const dependencies = {
        repository,
        publish,
        id,
        now,
        contextSize: 64_000,
        runtimeWorkspace: "/workspace/run-1",
        ownershipSignal: ownership.signal,
      };
      const events = new DurableRunEvents(dependencies);
      const caller = callerInput(operation);
      vi.useFakeTimers({ loopLimit: 20 });
      const result = observe(caller.invoke(events));
      try {
        await Promise.race([
          entered.promise,
          result.settled.then(() => {
            throw new Error("Event operation settled before the held persistence attempt");
          }),
        ]);
        expect(write).toHaveBeenCalledOnce();
        expect(publish).not.toHaveBeenCalled();
        caller.mutate();
        sourceDate.setUTCFullYear(2040);
        const heldInputAfterCallerMutation = structuredClone(inputs[0]!);

        release.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(write).toHaveBeenCalledOnce();
        expect(result.resolved).not.toHaveBeenCalled();
        expect(result.rejected).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        await vi.advanceTimersToNextTimerAsync();
        await result.settled;
        expect(write).toHaveBeenCalledTimes(2);
        expect(vi.mocked(repository)[repositoryMethod].mock.calls).toHaveLength(2);
        expect(snapshots).toHaveLength(2);
        expect(heldInputAfterCallerMutation).toStrictEqual(snapshots[0]);
        expect(inputs[0]).toStrictEqual(snapshots[0]);
        expect(snapshots[1]).toStrictEqual(snapshots[0]);
        expect(snapshots[0]?.createdAt).toEqual(new Date("2026-10-21T00:00:00.000Z"));
        expect(now).toHaveBeenCalledOnce();
        expect(id.mock.calls).toEqual(operation === "updatePlan" ? [] : [["message"]]);
        expect(result.rejected).not.toHaveBeenCalled();
        expect(result.resolved).toHaveBeenCalledExactlyOnceWith(
          operation === "updatePlan" ? true : undefined,
        );
        const firstInput = snapshots[0]!;
        const published = "events" in firstInput ? firstInput.events : [receipt];
        expect(publish.mock.calls).toEqual(published.map((event) => [event]));
        expect(publish).toHaveBeenCalledTimes(operation === "updatePlan" ? 2 : 1);
        expect(vi.getTimerCount()).toBe(0);
        await vi.runAllTimersAsync();
        expect(write).toHaveBeenCalledTimes(2);
        expect(publish.mock.calls).toEqual(published.map((event) => [event]));
      } finally {
        release.resolve();
        ownership.abort(new WorkerOwnershipLostError());
        try {
          await vi.runAllTimersAsync();
          await result.settled;
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      }
    },
  );
});

function observe(pending: Promise<unknown>) {
  const resolved = vi.fn<(value: unknown) => void>();
  const rejected = vi.fn<(error: unknown) => void>();
  return { resolved, rejected, settled: pending.then(resolved, rejected) };
}

function eventRepository(
  write: (input: WriteInput) => Promise<void>,
  receipt: SessionEvent,
): RunEventRepository {
  const append = async (input: WriteInput) => {
    await write(input);
    return receipt;
  };
  return {
    appendPlan: vi.fn<RunEventRepository["appendPlan"]>(async (input) => {
      await write(input);
      return true;
    }),
    appendAgentMessage: vi.fn(append),
    appendAgentThought: vi.fn(append),
    appendToolProgress: vi.fn(append),
    appendRejectedToolCall: vi.fn(append),
    appendUsage: vi.fn(append),
    startToolAttempt: vi.fn(append),
    finishToolAttempt: vi.fn(append),
    interruptToolAttempts: vi.fn(),
  };
}

function callerInput(operation: Operation) {
  const entries: PlanEntry[] = [{ content: "Original plan", priority: "high", status: "pending" }];
  const arguments_ = {
    path: "notes.txt",
    nested: { value: "original arguments", flags: ["original"] },
    entries,
  };
  const call = { id: "call-1", name: "write", arguments: arguments_ };
  const calls = [call];
  const content = [{ type: "text", text: "Original content", metadata: { labels: ["original"] } }];
  const schema = {
    type: "object",
    properties: { path: { type: "string", description: "Original path" } },
  };
  const tool: ModelToolDefinition = {
    source: "runtime",
    sourceId: "runtime",
    name: "write",
    modelName: "write",
    description: "Original tool",
    inputSchema: schema,
  };
  const details = {
    runtimeCallStopped: true,
    file: { path: "notes.txt", change: { before: "before", after: "after" } },
    rawOutput: { nested: { value: "original output" } },
  };
  const pricing = { currency: "USD" as const, inputPerMillion: 1, outputPerMillion: 2 };
  const usage: ModelUsage = {
    inputTokens: 13,
    outputTokens: 7,
    cost: { amount: 0.5, currency: "USD", source: "estimated", pricing },
  };
  return {
    invoke(events: DurableRunEvents): Promise<unknown> {
      switch (operation) {
        case "updatePlan":
          return events.updatePlan("run-1", call, entries);
        case "toolProgress":
          return events.toolProgress("run-1", "call-1", content);
        case "toolStarted":
          return events.toolStarted("run-1", "call-1", tool, arguments_);
        case "toolRejected":
          return events.toolRejected("run-1", call, "Tool rejected");
        case "toolFinished":
          return events.toolFinished("run-1", "call-1", "completed", content, "settled", details);
        case "agentMessage":
          return events.agentMessage("run-1", content, calls, "response-1");
        case "agentThought":
          return events.agentThought("run-1", content, "thought-1");
        case "usage":
          return events.usage("run-1", usage);
      }
    },
    mutate() {
      entries[0]!.content = "Changed plan";
      entries[0]!.status = "completed";
      arguments_.path = "changed.txt";
      arguments_.nested.value = "changed arguments";
      arguments_.nested.flags.push("changed");
      call.id = "changed-call";
      call.name = "changed-tool";
      content[0]!.text = "Changed content";
      content[0]!.metadata.labels.push("changed");
      schema.properties.path.description = "Changed path";
      tool.description = "Changed tool";
      details.runtimeCallStopped = false;
      details.file.path = "changed.txt";
      details.file.change.after = "changed after";
      details.rawOutput.nested.value = "changed output";
      usage.inputTokens = 999;
      usage.cost!.amount = 99;
      pricing.inputPerMillion = 999;
    },
  };
}

function persistedEvent(operation: Operation): SessionEvent {
  switch (operation) {
    case "toolStarted":
    case "toolRejected":
    case "toolProgress":
    case "toolFinished":
      return {
        kind: "tool_call",
        initial: operation === "toolStarted" || operation === "toolRejected",
        toolCallId: "call-1",
        title: "Write",
        status:
          operation === "toolRejected"
            ? "failed"
            : operation === "toolFinished"
              ? "completed"
              : "in_progress",
      };
    case "agentThought":
      return {
        kind: "agent_thought",
        messageId: "message-1",
        content: [{ type: "text", text: "Stored thought" }],
      };
    case "usage":
      return { kind: "usage", used: 20, size: 64_000 };
    case "agentMessage":
    case "updatePlan":
      return {
        kind: "agent_message",
        messageId: "message-1",
        content: [{ type: "text", text: "Stored message" }],
      };
  }
}
