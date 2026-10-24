import { describe, expect, it, vi } from "vitest";
import { PermissionJudge } from "../../src/application/permission-judge.js";
import { ModelCallPolicy } from "../../src/application/model-call-policy.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { ModelRequestBudget } from "../../src/application/model-request-budget.js";
import type { ModelPort, ModelResult } from "../../src/ports/model.js";
import { ModelError, ModelTransportCleanupError } from "../../src/ports/model.js";
import { snapshot } from "../support/fixtures.js";

function setup(limit = 4) {
  const model = { complete: vi.fn<ModelPort["complete"]>() };
  const usage = vi.fn().mockResolvedValue(undefined);
  const budget = new ModelRequestBudget(limit);
  const judge = new PermissionJudge(
    new ModelCallPolicy({
      model,
      budget,
      attempts: {
        start: () => Promise.resolve(),
        finish: async (runId, fact) => {
          await usage(runId, fact.usage);
        },
      },
    }),
  );
  const cancellation = new AbortController();
  const input = {
    snapshot: { ...snapshot(), deadlineAt: new Date(Date.now() + 60_000) },
    credential: "secret",
    signal: cancellation.signal,
    authoritySignal: new AbortController().signal,
    runId: "r",
    sessionId: "s",
    context: [],
  };
  const prepared = {
    tool: {
      source: "runtime" as const,
      sourceId: "runtime",
      name: "bash",
      modelName: "bash",
      description: "Execute a command",
    },
    call: { id: "call-1", name: "bash", arguments: { command: "pwd" } },
  };
  const answer = (text = '{"request_id":"call-1","read_only":true}'): ModelResult => ({
    kind: "message",
    stopReason: "end_turn",
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  model.complete.mockResolvedValue(answer());
  return { judge, budget, model, usage, input, prepared, answer, cancellation };
}
describe("Smart Approve exact-call read-only judge", () => {
  it("records returned fees even when the classifier completion is invalid", async () => {
    const h = setup();
    const error = new ModelError("model_invalid_response", "invalid", false);
    error.usage = { cost: { amount: 0.01, currency: "USD", source: "provider_reported" } };
    h.model.complete.mockRejectedValue(error);
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(false);
    expect(h.usage).toHaveBeenCalledExactlyOnceWith("r", error.usage);
    h.usage.mockRejectedValue(new Error("persistence failed"));
    await expect(h.judge.readOnly(h.input, h.prepared)).rejects.toThrow("persistence failed");
  });
  it("uses isolated untrusted input, no tools or streaming output, and records usage", async () => {
    const h = setup();
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(true);
    const request = h.model.complete.mock.calls[0]![0];
    expect(request.tools).toEqual([]);
    expect(request.onDelta).toBeUndefined();
    expect(request.purpose).toBe("permission_judge");
    expect(request.snapshot.executionSpec.model.maxOutputTokens).toBe(256);
    expect(request.messages).toHaveLength(2);
    expect(request.messages[1]).toMatchObject({ role: "user" });
    expect(h.usage).toHaveBeenCalledWith("r", { inputTokens: 10, outputTokens: 5 });
    expect(h.input.snapshot.executionSpec.model.maxOutputTokens).toBe(4096);
  });
  it.each([
    "{}",
    "true",
    "```json\n{}\n```",
    '{"request_id":"other","read_only":true}',
    '{"request_id":"call-1","read_only":false}',
    '{"request_id":"call-1","read_only":"true"}',
    '{"request_id":"call-1","read_only":true,"extra":1}',
  ])("asks for invalid or negative output %s", async (text) => {
    const h = setup();
    h.model.complete.mockResolvedValue(h.answer(text));
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(false);
  });
  it("does not accept truncated output or tool calls", async () => {
    const h = setup();
    h.model.complete.mockResolvedValue({ ...h.answer(), stopReason: "max_tokens" } as ModelResult);
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(false);
    h.model.complete.mockResolvedValue({
      kind: "tool_calls",
      calls: [],
      content: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(false);
  });
  it("reserves a normal response and charges failed judge attempts without caching", async () => {
    const h = setup(3);
    expect(h.budget.take()).toBe(true);
    h.model.complete.mockRejectedValue(new Error("provider offline"));
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(false);
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(false);
    expect(h.model.complete).toHaveBeenCalledOnce();
    expect(h.budget.take()).toBe(true);
    expect(h.budget.take()).toBe(false);
  });
  it("does not cache positive decisions for changed arguments", async () => {
    const h = setup();
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(true);
    h.prepared.call.arguments.command = "rm -rf data";
    h.model.complete.mockResolvedValue(h.answer('{"request_id":"call-1","read_only":false}'));
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(false);
    expect(h.model.complete).toHaveBeenCalledTimes(2);
  });
  it("fails closed on oversized context without spending a request", async () => {
    const h = setup();
    h.prepared.call.arguments.command = "x".repeat(300000);
    expect(await h.judge.readOnly(h.input, h.prepared)).toBe(false);
    expect(h.model.complete).not.toHaveBeenCalled();
  });
  it("does not swallow accounting failures or cancellation", async () => {
    const h = setup();
    h.usage.mockRejectedValue(new Error("persistence failed"));
    await expect(h.judge.readOnly(h.input, h.prepared)).rejects.toThrow("persistence failed");
    h.cancellation.abort();
    await expect(h.judge.readOnly(h.input, h.prepared)).rejects.toThrow();
  });
  it.each(["active", "cancelled", "revoked"] as const)(
    "preserves the original model cleanup failure when the judge is %s",
    async (mode) => {
      const h = setup();
      const authority = new AbortController();
      h.input.authoritySignal = authority.signal;
      const cleanup = new ModelTransportCleanupError(
        new Error("original cleanup failed"),
        { inputTokens: 7, outputTokens: 2 },
        true,
      );
      h.model.complete.mockImplementation(() => {
        if (mode === "cancelled") h.cancellation.abort();
        if (mode === "revoked") authority.abort();
        return Promise.reject(cleanup);
      });
      await expect(h.judge.readOnly(h.input, h.prepared)).rejects.toBe(cleanup);
      expect(h.usage).toHaveBeenCalledExactlyOnceWith("r", cleanup.usage);
    },
  );
  it.each([new Error("usage persistence failed"), undefined])(
    "retains model cleanup and accounting failure together (%s)",
    async (accountingError) => {
      const h = setup();
      const cleanup = new ModelTransportCleanupError(
        new Error("original cleanup failed"),
        { inputTokens: 7, outputTokens: 2 },
        true,
      );
      h.model.complete.mockRejectedValue(cleanup);
      h.usage.mockRejectedValue(accountingError);
      const failure: unknown = await h.judge.readOnly(h.input, h.prepared).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ModelTransportCleanupError);
      if (!(failure instanceof ModelTransportCleanupError))
        throw new Error("Expected model transport cleanup failure");
      const cause = failure.cause;
      expect(cause).toBeInstanceOf(AggregateError);
      if (!(cause instanceof AggregateError))
        throw new Error("Expected aggregate cleanup and accounting failure");
      expect(cause.errors).toHaveLength(2);
      expect(cause.errors[0]).toBe(cleanup);
      expect(cause.errors[1]).toBeInstanceOf(RunEventPersistenceError);
      expect((cause.errors[1] as RunEventPersistenceError).cause).toBe(accountingError);
      expect(h.usage).toHaveBeenCalledExactlyOnceWith("r", cleanup.usage);
    },
  );
});
