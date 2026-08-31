import { describe, expect, it, vi } from "vitest";

import {
  DurableRunEvents,
  RunEventPersistenceError,
} from "../../src/application/durable-run-events.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";

describe("DurableRunEvents", () => {
  it("persists Tool metadata before publishing and never lets a disconnected client fail the Run", async () => {
    const order: string[] = [];
    const startToolAttempt = vi.fn<RunEventRepository["startToolAttempt"]>((input) =>
      Promise.resolve().then(() => {
        order.push("persist");
        return {
          kind: "tool_call",
          initial: true,
          toolCallId: input.toolCallId,
          title: input.tool.name,
          status: "in_progress",
        };
      }),
    );
    const repository: RunEventRepository = {
      appendAgentMessage: vi.fn(),
      appendAgentThought: vi.fn(),
      appendRejectedToolCall: vi.fn(),
      appendUsage: vi.fn(),
      startToolAttempt,
      finishToolAttempt: vi.fn(),
      interruptToolAttempts: vi.fn(),
    };
    const events = new DurableRunEvents({
      repository,
      publish: vi.fn(() =>
        Promise.resolve().then(() => {
          order.push("publish");
          throw new Error("connection closed");
        }),
      ),
      id: () => "event-1",
      now: () => new Date("2026-08-30T00:00:00Z"),
      contextSize: 64_000,
    });

    await expect(
      events.toolStarted(
        "run-1",
        "call-1",
        {
          source: "runtime",
          sourceId: "runtime",
          name: "write",
          modelName: "write",
          description: "Write",
        },
        { text: "secret", path: "notes.txt" },
      ),
    ).resolves.toBeUndefined();

    expect(order).toEqual(["persist", "publish"]);
    const persisted = startToolAttempt.mock.calls[0]?.[0];
    expect(persisted?.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not let a half-open live publisher block durable execution", async () => {
    const repository: RunEventRepository = {
      appendAgentMessage: vi.fn(() =>
        Promise.resolve({
          kind: "agent_message" as const,
          messageId: "message-1",
          content: [{ type: "text", text: "done" }],
        }),
      ),
      appendAgentThought: vi.fn(),
      appendRejectedToolCall: vi.fn(),
      appendUsage: vi.fn(),
      startToolAttempt: vi.fn(),
      finishToolAttempt: vi.fn(),
      interruptToolAttempts: vi.fn(),
    };
    const publish = vi.fn(() => new Promise<void>(() => undefined));
    const events = new DurableRunEvents({
      repository,
      publish,
      id: () => "message-1",
      now: () => new Date("2026-08-30T00:00:00Z"),
      contextSize: 64_000,
    });

    const result = await Promise.race([
      events.agentMessage("run-1", [{ type: "text", text: "done" }]).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 20)),
    ]);

    expect(result).toBe("completed");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("classifies repository failure separately from best-effort publication", async () => {
    const repository: RunEventRepository = {
      appendAgentMessage: vi.fn(() => Promise.reject(new Error("database unavailable"))),
      appendAgentThought: vi.fn(),
      appendRejectedToolCall: vi.fn(),
      appendUsage: vi.fn(),
      startToolAttempt: vi.fn(),
      finishToolAttempt: vi.fn(),
      interruptToolAttempts: vi.fn(),
    };
    const publish = vi.fn();
    const events = new DurableRunEvents({
      repository,
      publish,
      id: () => "message-1",
      now: () => new Date("2026-08-30T00:00:00Z"),
      contextSize: 64_000,
    });

    await expect(
      events.agentMessage("run-1", [{ type: "text", text: "done" }]),
    ).rejects.toBeInstanceOf(RunEventPersistenceError);
    expect(publish).not.toHaveBeenCalled();
  });
});
