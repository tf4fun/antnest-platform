import { describe, expect, it, vi } from "vitest";
import { TurnRunner } from "../../src/application/turn-runner.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { planTool } from "../../src/domain/plan.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { RunEventPort } from "../../src/ports/run-events.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import { snapshot } from "../support/fixtures.js";

function fixture() {
  const events = {
    updatePlan: vi.fn<RunEventPort["updatePlan"]>(() => Promise.resolve(true)),
    agentMessage: vi.fn(),
    agentThought: vi.fn(),
    usage: vi.fn(),
    toolStarted: vi.fn(),
    toolProgress: vi.fn(),
    toolFinished: vi.fn(),
    toolRejected: vi.fn(),
  } satisfies RunEventPort;
  const model = vi.fn<ModelPort["complete"]>().mockResolvedValue({
    kind: "message",
    content: [{ type: "text", text: "done" }],
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  });
  const call = vi.fn<ToolCatalogPort["call"]>();
  const signal = new AbortController();
  const authority = new AbortController();
  const entries = [{ content: "inspect", priority: "high", status: "pending" }];
  const response = {
    kind: "tool_calls" as const,
    content: [],
    calls: [{ id: "call", name: "update_plan", arguments: { entries } }],
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  model.mockResolvedValueOnce(response);
  const runner = new TurnRunner({
    model: { complete: model },
    tools: { call },
    events,
    catalog: [planTool],
  });
  return {
    events,
    model,
    call,
    signal,
    authority,
    response,
    run: () =>
      runner.run({
        runId: "run",
        sessionId: "session",
        snapshot: snapshot(),
        credential: "fixture",
        context: [],
        signal: signal.signal,
        authoritySignal: authority.signal,
      }),
  };
}
describe("Local plan execution", () => {
  it("commits a validated local plan and feeds its result to the model without a remote attempt", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ terminalClass: "completed", toolEffectState: "none" });
    expect(f.events.updatePlan).toHaveBeenCalledOnce();
    expect(f.events.updatePlan.mock.calls[0]?.[1].id).not.toBe("call");
    expect(f.call).not.toHaveBeenCalled();
    expect(f.events.toolStarted).not.toHaveBeenCalled();
    expect(f.events.toolFinished).not.toHaveBeenCalled();
    expect(f.model.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "text", text: "Plan updated." }],
    });
  });
  it("rejects an invalid plan as a Tool result, not a partial state mutation", async () => {
    const f = fixture();
    f.response.calls[0]!.arguments.entries[0]!.priority = "invalid";
    expect(await f.run()).toMatchObject({ terminalClass: "completed" });
    expect(f.events.updatePlan).not.toHaveBeenCalled();
    expect(f.events.toolRejected).toHaveBeenCalledOnce();
    expect(f.call).not.toHaveBeenCalled();
  });
  it("does not turn a Markdown list into a plan", async () => {
    const f = fixture();
    f.model.mockReset().mockResolvedValue({
      kind: "message",
      content: [{ type: "text", text: "1. inspect\n2. test" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    });
    await f.run();
    expect(f.events.updatePlan).not.toHaveBeenCalled();
  });
  it("closes the undispatched model call when cancellation precedes dispatch", async () => {
    const f = fixture();
    f.model.mockReset().mockImplementation(() => {
      f.signal.abort();
      return Promise.resolve(f.response);
    });
    expect(await f.run()).toMatchObject({ terminalClass: "cancelled", toolEffectState: "none" });
    expect(f.events.updatePlan).not.toHaveBeenCalled();
    expect(f.events.toolRejected).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "handles cancellation at the persistence boundary (applied=%j)",
    async (applied) => {
      const f = fixture();
      f.events.updatePlan.mockImplementation(() => {
        if (applied) f.signal.abort();
        return Promise.resolve(applied);
      });
      expect(await f.run()).toMatchObject({ terminalClass: "cancelled", toolEffectState: "none" });
      expect(f.events.toolRejected).toHaveBeenCalledTimes(applied ? 0 : 1);
      expect(f.call).not.toHaveBeenCalled();
    },
  );
  it("propagates persistence failure for recovery without manufacturing remote unknown effects", async () => {
    const f = fixture();
    f.events.updatePlan.mockRejectedValue(new RunEventPersistenceError("plan", new Error("db")));
    await expect(f.run()).rejects.toBeInstanceOf(RunEventPersistenceError);
    expect(f.events.toolFinished).not.toHaveBeenCalled();
    expect(f.model).toHaveBeenCalledOnce();
  });
  it("does not continue when worker authority is lost during persistence", async () => {
    const f = fixture();
    f.events.updatePlan.mockImplementation(() => {
      f.authority.abort(new Error("lost authority"));
      return Promise.resolve(true);
    });
    await expect(f.run()).rejects.toThrow("lost authority");
    expect(f.model).toHaveBeenCalledOnce();
    expect(f.call).not.toHaveBeenCalled();
  });
});
