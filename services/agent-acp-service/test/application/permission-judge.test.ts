import { describe, expect, it, vi } from "vitest";
import { PermissionJudge, ModelRequestBudget } from "../../src/application/permission-judge.js";
import type { ModelPort, ModelResult } from "../../src/ports/model.js";
import { ModelError } from "../../src/ports/model.js";
import { snapshot } from "../support/fixtures.js";

function setup(limit = 4) {
  const model = { complete: vi.fn<ModelPort["complete"]>() };
  const usage = vi.fn().mockResolvedValue(undefined);
  const budget = new ModelRequestBudget(limit);
  const judge = new PermissionJudge(model, budget, usage);
  const cancellation = new AbortController();
  const input = {
    snapshot: snapshot(),
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
});
