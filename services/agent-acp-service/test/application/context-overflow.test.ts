import { describe, expect, it, vi } from "vitest";

import { TurnRunner } from "../../src/application/turn-runner.js";
import { ModelError, type ModelPort } from "../../src/ports/model.js";
import type { RunEventPort } from "../../src/ports/run-events.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import type { ModelMessage, RunExecutionSnapshot } from "../../src/domain/types.js";
import { snapshot as baseSnapshot } from "../support/fixtures.js";

function runSnapshot(maxModelRequests = 8): RunExecutionSnapshot {
  const run = baseSnapshot();
  run.executionSpec.maxModelRequests = maxModelRequests;
  return run;
}

function context(): ModelMessage[] {
  return [
    { role: "system", content: [{ type: "text", text: "You are useful." }] },
    { role: "user", content: [{ type: "text", text: "Original task" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "I will read the file." }],
      toolCalls: [{ id: "call-1", name: "read", arguments: { path: "notes.txt" } }],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      content: [{ type: "text", text: `RESULT ${"DATA".repeat(4_000)}` }],
    },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ];
}

function createEvents() {
  const start = vi.fn<RunEventPort["start"]>(() => Promise.resolve());
  const port: RunEventPort = {
    start,
    finish: vi.fn(() => Promise.resolve()),
    updatePlan: vi.fn(() => Promise.resolve(true)),
    toolProgress: vi.fn(() => Promise.resolve()),
    toolStarted: vi.fn(() => Promise.resolve()),
    toolRejected: vi.fn(() => Promise.resolve()),
    toolFinished: vi.fn(() => Promise.resolve()),
    agentMessage: vi.fn(() => Promise.resolve()),
    agentThought: vi.fn(() => Promise.resolve()),
    usage: vi.fn(() => Promise.resolve()),
  };
  return { port, start };
}

function purposes(calls: [runId: string, fact: { purpose?: string }][]) {
  return calls.map(([, fact]) => fact.purpose);
}

describe("TurnRunner context overflow recovery", () => {
  it("compacts once after a context overflow and retries the foreground call", async () => {
    const complete = vi
      .fn<ModelPort["complete"]>()
      .mockRejectedValueOnce(new ModelError("context_overflow", "context too large", false, 400))
      .mockResolvedValueOnce({
        kind: "message",
        content: [{ type: "text", text: "压缩摘要" }],
        usage: {},
        stopReason: "end_turn",
      })
      .mockResolvedValueOnce({
        kind: "message",
        content: [{ type: "text", text: "done" }],
        usage: {},
        stopReason: "end_turn",
      });
    const call = vi.fn<ToolCatalogPort["call"]>();
    const events = createEvents();
    const runner = new TurnRunner({
      model: { complete },
      tools: { call },
      catalog: [],
      events: events.port,
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    await expect(
      runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot: runSnapshot(),
        context: context(),
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ terminalClass: "completed" });
    expect(complete).toHaveBeenCalledTimes(3);
    const requests = complete.mock.calls.map(([request]) => request);
    const foreground = requests.filter((request) => request.purpose !== "compaction");
    const compaction = requests.filter((request) => request.purpose === "compaction");
    expect(foreground).toHaveLength(2);
    expect(compaction).toHaveLength(1);
    for (const request of foreground) {
      expect(JSON.stringify(request.messages)).toContain("Original task");
    }
    expect(call).not.toHaveBeenCalled();
    expect(purposes(events.start.mock.calls)).toContain("compaction");
  });

  it("fails with context_overflow when the retried foreground overflows again", async () => {
    const complete = vi
      .fn<ModelPort["complete"]>()
      .mockRejectedValueOnce(new ModelError("context_overflow", "context too large", false, 400))
      .mockResolvedValueOnce({
        kind: "message",
        content: [{ type: "text", text: "摘要" }],
        usage: {},
        stopReason: "end_turn",
      })
      .mockRejectedValueOnce(new ModelError("context_overflow", "still too large", false, 400));
    const runner = new TurnRunner({
      model: { complete },
      tools: { call: vi.fn<ToolCatalogPort["call"]>() },
      catalog: [],
      events: createEvents().port,
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    await expect(
      runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot: runSnapshot(),
        context: context(),
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ terminalClass: "failed", errorClass: "context_overflow" });
    expect(complete).toHaveBeenCalledTimes(3);
    const foreground = complete.mock.calls.filter(([request]) => request.purpose !== "compaction");
    expect(foreground).toHaveLength(2);
  });

  it("never retries or compacts when the overflow already produced output", async () => {
    const overflow = new ModelError("context_overflow", "context too large", false, 400);
    overflow.outputStarted = true;
    const complete = vi.fn<ModelPort["complete"]>().mockRejectedValueOnce(overflow);
    const events = createEvents();
    const runner = new TurnRunner({
      model: { complete },
      tools: { call: vi.fn<ToolCatalogPort["call"]>() },
      catalog: [],
      events: events.port,
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    await expect(
      runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot: runSnapshot(),
        context: context(),
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ terminalClass: "failed" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(purposes(events.start.mock.calls)).not.toContain("compaction");
  });

  it("stops without a summarization call when the shared request budget is exhausted", async () => {
    const complete = vi
      .fn<ModelPort["complete"]>()
      .mockRejectedValueOnce(new ModelError("context_overflow", "context too large", false, 400));
    const events = createEvents();
    const runner = new TurnRunner({
      model: { complete },
      tools: { call: vi.fn<ToolCatalogPort["call"]>() },
      catalog: [],
      events: events.port,
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    await expect(
      runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot: runSnapshot(1),
        context: context(),
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ stopReason: "max_turn_requests" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(purposes(events.start.mock.calls)).not.toContain("compaction");
  });
});
