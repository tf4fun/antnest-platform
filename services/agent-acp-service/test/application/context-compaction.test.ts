import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  COMPACTION_PROMPT_VERSION,
  compactModelContext,
  type CompactionComplete,
} from "../../src/application/context-compaction.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { ModelRequestLimitError } from "../../src/application/model-request-budget.js";
import { ModelBudgetExceededError } from "../../src/domain/model-budget.js";
import { inputBudget } from "../../src/application/context-budget.js";
import { createTokenEstimator } from "../../src/application/token-estimator.js";
import { ModelError, type ModelRequest, type ModelResult } from "../../src/ports/model.js";
import type { ModelMessage, RunExecutionSnapshot } from "../../src/domain/types.js";
import { snapshot as baseSnapshot } from "../support/fixtures.js";

function runSnapshot(contextWindow = 1_024): RunExecutionSnapshot {
  const run = baseSnapshot();
  run.executionSpec.model.contextWindow = contextWindow;
  run.executionSpec.model.maxOutputTokens = 128;
  run.executionSpec.model.tokenizer = "o200k";
  return run;
}

function textMessage(role: "system" | "user" | "assistant", text: string): ModelMessage {
  return { role, content: [{ type: "text", text }] };
}

function summaryResult(summary: string): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text: summary }],
    usage: {},
    stopReason: "end_turn",
  };
}

function history(): ModelMessage[] {
  const middle: ModelMessage[] = [];
  for (let index = 0; index < 6; index += 1) {
    middle.push(
      textMessage("user", `历史问题${index}${"中".repeat(400)}`),
      textMessage("assistant", `历史回答${index}${"文".repeat(400)}`),
    );
  }
  return [
    textMessage("system", "You are useful."),
    textMessage("system", "Earlier conversation summary:\n此前的摘要"),
    textMessage("user", "Original task 原始任务"),
    ...middle,
    textMessage("user", "Latest question 最新问题"),
  ];
}

function requestMaxOutputTokens(request: ModelRequest): number {
  if ("maxOutputTokens" in request && typeof request.maxOutputTokens === "number")
    return request.maxOutputTokens;
  return request.snapshot.executionSpec.model.maxOutputTokens;
}

describe("compactModelContext", () => {
  it("summarizes long history through the configured tokenizer while pinning frame, first task and tail", async () => {
    const complete = vi.fn<CompactionComplete>(() =>
      Promise.resolve<ModelResult>(summaryResult("浓缩摘要")),
    );
    const result = await compactModelContext({
      snapshot: runSnapshot(),
      messages: history(),
      tools: [],
      signal: new AbortController().signal,
      complete,
    });
    expect(result.fallback).toBe(false);
    expect(result.promptVersion).toBe(COMPACTION_PROMPT_VERSION);
    expect(result.summary).toBe("浓缩摘要");
    const rendered = JSON.stringify(result.messages);
    expect(rendered).toContain("You are useful.");
    expect(rendered).toContain("Original task 原始任务");
    expect(rendered).toContain("Latest question 最新问题");
    expect(rendered).toContain("Earlier conversation summary");
    expect(rendered).toContain("浓缩摘要");
    expect(rendered).not.toContain("历史问题3");
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]![0];
    expect(request.purpose).toBe("compaction");
    expect(request.tools).toEqual([]);
    expect(request.onDelta).toBeUndefined();
    const prompt = JSON.stringify(request.messages);
    expect(prompt).toContain("此前的摘要");
    expect(prompt).toContain("历史问题0");
    expect(requestMaxOutputTokens(request)).toBeLessThanOrEqual(128);
    expect(requestMaxOutputTokens(request)).toBeLessThanOrEqual(
      Math.ceil(0.15 * (1024 - 128 - 256)),
    );
  });

  it("uses the frozen compaction model for the summarization request when configured", async () => {
    const run = runSnapshot();
    run.executionSpec.compactionModel = {
      modelProfileId: "model-compaction",
      providerConnectionId: "provider-compaction",
      model: {
        baseUrl: "https://compaction.example.test/v1",
        model: "compaction-model",
        contextWindow: 32_000,
        maxOutputTokens: 2_048,
        supportsImages: false,
      },
    };
    const complete = vi.fn<CompactionComplete>(() =>
      Promise.resolve<ModelResult>(summaryResult("compacted")),
    );
    await compactModelContext({
      snapshot: run,
      messages: history(),
      tools: [],
      signal: new AbortController().signal,
      complete,
    });
    const request = complete.mock.calls[0]![0];
    expect(request.purpose).toBe("compaction");
    expect(JSON.stringify(request)).toContain("compaction-model");
  });

  it("falls back to a bounded mechanical summary preserving the previous summary first on model failure", async () => {
    const previous = history();
    const result = await compactModelContext({
      snapshot: runSnapshot(),
      messages: previous,
      tools: [],
      signal: new AbortController().signal,
      complete: () => Promise.reject(new ModelError("model_unavailable", "down", false)),
    });
    expect(result.fallback).toBe(true);
    expect(result.promptVersion).toBe(COMPACTION_PROMPT_VERSION);
    expect(result.summary.length).toBeGreaterThan(0);
    const rendered = JSON.stringify(result.messages);
    expect(rendered).toContain("此前的摘要");
    expect(rendered).toContain("Original task 原始任务");
    expect(rendered).toContain("Latest question 最新问题");
    expect(rendered).not.toContain("历史问题3");
  });

  it("produces a deterministic mechanical summary when no model call is supplied", async () => {
    const input = {
      snapshot: runSnapshot(),
      messages: history(),
      tools: [],
      signal: new AbortController().signal,
    };
    const first = await compactModelContext(input);
    const second = await compactModelContext({
      ...input,
      messages: structuredClone(input.messages),
    });
    expect(first.fallback).toBe(true);
    expect(first.summary).toBe(second.summary);
    expect(first.messages).toEqual(second.messages);
    expect(
      createTokenEstimator(input.snapshot.executionSpec.model).estimateText(first.summary),
    ).toBeLessThanOrEqual(Math.floor(inputBudget(input.snapshot, []) * 0.15));
  });

  it.each([
    ["model budget", new ModelBudgetExceededError("run_input", "10", "20")],
    ["request limit", new ModelRequestLimitError()],
    ["event persistence", new RunEventPersistenceError("model attempt start", new Error("db"))],
  ])("rethrows %s failures instead of falling back", async (_name, failure) => {
    await expect(
      compactModelContext({
        snapshot: runSnapshot(),
        messages: history(),
        tools: [],
        signal: new AbortController().signal,
        complete: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });

  it("never swallows cancellation", async () => {
    const ownership = new AbortController();
    ownership.abort(new Error("worker lock lost"));
    await expect(
      compactModelContext({
        snapshot: runSnapshot(),
        messages: history(),
        tools: [],
        signal: ownership.signal,
        complete: () => Promise.resolve(summaryResult("never")),
      }),
    ).rejects.toThrow("worker lock lost");
  });

  it("bounds oversized Tool results with head and tail plus a content digest", async () => {
    const big = `RESULT-${"DATA".repeat(20_000)}-END`;
    const digest = createHash("sha256").update(big).digest("hex");
    const messages: ModelMessage[] = [
      textMessage("system", "You are useful."),
      textMessage("user", "Original task"),
      ...history().slice(3, -1),
      {
        role: "assistant",
        content: [{ type: "text", text: "I will read the file." }],
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "big.log" } }],
      },
      { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: big }] },
      textMessage("user", "Latest question"),
    ];
    const result = await compactModelContext({
      snapshot: runSnapshot(),
      messages,
      tools: [],
      signal: new AbortController().signal,
      complete: () => Promise.resolve(summaryResult("summarized")),
    });
    const rendered = JSON.stringify(result.messages);
    expect(rendered).not.toContain(big);
    expect(rendered).toContain(digest);
    expect(rendered).toContain(big.slice(0, 64));
    expect(rendered).toContain(big.slice(-64));
    expect(rendered).toContain("chars elided");
    expect(rendered).not.toContain("Tool result truncated");
  });

  it("bounds a fitting Tool result without summarization or drops", async () => {
    const big = `RESULT-${"DATA".repeat(600)}-END`;
    const digest = createHash("sha256").update(big).digest("hex");
    const messages: ModelMessage[] = [
      textMessage("system", "You are useful."),
      textMessage("user", "Original task"),
      {
        role: "assistant",
        content: [{ type: "text", text: "I will read the file." }],
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "big.log" } }],
      },
      { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: big }] },
      textMessage("user", "Latest question"),
    ];
    const complete = vi.fn<CompactionComplete>();
    const result = await compactModelContext({
      snapshot: runSnapshot(),
      messages,
      tools: [],
      signal: new AbortController().signal,
      complete,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.summary).toBe("");
    expect(result.droppedIndexes).toEqual([]);
    const rendered = JSON.stringify(result.messages);
    expect(rendered).not.toContain(big);
    expect(rendered).toContain(digest);
    expect(rendered).toContain("call-1");
    expect(rendered).toContain("Latest question");
  });

  it("keeps complete Tool exchanges atomic instead of splitting calls from results", async () => {
    const messages: ModelMessage[] = [
      textMessage("system", "You are useful."),
      textMessage("user", "Original task"),
      ...history().slice(3, -1),
      {
        role: "assistant",
        content: [{ type: "text", text: "I will read the file." }],
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a.txt" } }],
      },
      { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "file contents" }] },
      textMessage("user", "Latest question"),
    ];
    const result = await compactModelContext({
      snapshot: runSnapshot(),
      messages,
      tools: [],
      signal: new AbortController().signal,
      complete: () => Promise.resolve(summaryResult("summarized")),
    });
    for (const id of ["call-1"]) {
      const call = result.messages.find(
        (message) =>
          message.role === "assistant" && message.toolCalls?.some((entry) => entry.id === id),
      );
      const tool = result.messages.find(
        (message) => message.role === "tool" && message.toolCallId === id,
      );
      expect(call === undefined).toBe(tool === undefined);
    }
    expect(JSON.stringify(result.messages)).toContain("file contents");
  });

  it("reduces a fitting but long request when forced", async () => {
    const fitting: ModelMessage[] = [
      textMessage("system", "You are useful."),
      textMessage("user", "Original task"),
      textMessage("assistant", "intermediate ".repeat(120)),
      textMessage("user", "Latest question"),
    ];
    const complete = vi.fn<CompactionComplete>(() =>
      Promise.resolve<ModelResult>(summaryResult("forced summary")),
    );
    const result = await compactModelContext({
      snapshot: runSnapshot(16_000),
      messages: fitting,
      tools: [],
      signal: new AbortController().signal,
      complete,
      force: true,
    });
    expect(complete).toHaveBeenCalled();
    expect(result.summary).toBe("forced summary");
    expect(JSON.stringify(result.messages).length).toBeLessThan(JSON.stringify(fitting).length);
    expect(JSON.stringify(result.messages)).toContain("Original task");
    expect(JSON.stringify(result.messages)).toContain("Latest question");
  });

  it("retains a complete Tool exchange that follows the newest user message", async () => {
    const messages: ModelMessage[] = [
      textMessage("system", "You are useful."),
      textMessage("user", "Original task"),
      ...history().slice(3, -1),
      textMessage("user", "Latest question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "I will read the file." }],
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a.txt" } }],
      },
      { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "file contents" }] },
    ];
    const result = await compactModelContext({
      snapshot: runSnapshot(),
      messages,
      tools: [],
      signal: new AbortController().signal,
      complete: () => Promise.resolve(summaryResult("summarized")),
    });
    const rendered = JSON.stringify(result.messages);
    expect(rendered).toContain("call-1");
    expect(rendered).toContain("file contents");
    const call = result.messages.find(
      (message) =>
        message.role === "assistant" && message.toolCalls?.some((entry) => entry.id === "call-1"),
    );
    const tool = result.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call-1",
    );
    expect(call === undefined).toBe(tool === undefined);
  });

  it("pins a lone user message exactly once", async () => {
    const result = await compactModelContext({
      snapshot: runSnapshot(),
      messages: [
        textMessage("system", "You are useful."),
        textMessage("user", "Only task"),
        textMessage("assistant", `middle ${"x".repeat(4_000)}`),
      ],
      tools: [],
      signal: new AbortController().signal,
      complete: () => Promise.resolve(summaryResult("summarized")),
      force: true,
    });
    expect(result.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(result.messages)).toContain("Only task");
  });

  it("keeps the summarization prompt valid JSON with the prior summary and first dropped entry", async () => {
    const complete = vi.fn<CompactionComplete>(() =>
      Promise.resolve<ModelResult>(summaryResult("ok")),
    );
    await compactModelContext({
      snapshot: runSnapshot(4_096),
      messages: history(),
      tools: [],
      signal: new AbortController().signal,
      complete,
    });
    const request = complete.mock.calls[0]![0];
    const last = request.messages.at(-1);
    const text =
      last?.role === "user" &&
      last.content[0]?.type === "text" &&
      typeof last.content[0].text === "string"
        ? last.content[0].text
        : "";
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      previous_summary: "此前的摘要",
    });
    expect(JSON.stringify(parsed)).toContain("pinned");
    expect(JSON.stringify(parsed)).toContain("dropped_messages");
    expect(JSON.stringify(parsed)).toContain("历史问题0");
  });
});
