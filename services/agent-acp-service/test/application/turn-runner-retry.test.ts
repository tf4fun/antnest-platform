import { describe, expect, it, vi } from "vitest";
import { TurnRunner, type RunTurnInput } from "../../src/application/turn-runner.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { ModelBudgetExceededError } from "../../src/domain/model-budget.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
} from "../../src/ports/model.js";
import type { ModelAttemptPort } from "../../src/ports/model-attempts.js";
import type { RunEventPort } from "../../src/ports/run-events.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import type { ToolPermissionPort } from "../../src/ports/tool-permissions.js";
import { snapshot } from "../support/fixtures.js";

const failedUsage: ModelUsage = { inputTokens: 7, outputTokens: 2 };

function response(
  text = "done",
  usage: ModelUsage = { inputTokens: 11, outputTokens: 3 },
): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage,
  };
}

function toolResponse(): ModelResult {
  return {
    kind: "tool_calls",
    content: [],
    calls: [{ id: "provider-call-1", name: "bash", arguments: { command: "pwd" } }],
    usage: { inputTokens: 5, outputTokens: 1 },
  };
}

function retryable(status = 429): ModelError {
  const error = new ModelError("model_http_error", "provider-private-canary", true, status);
  error.usage = structuredClone(failedUsage);
  return error;
}

function judgeResponse(request: ModelRequest): ModelResult {
  const text = request.messages.find((message) => message.role === "user")?.content[0]?.text;
  if (typeof text !== "string") throw new Error("Expected the original judge input");
  const input: unknown = JSON.parse(text);
  if (
    typeof input !== "object" ||
    input === null ||
    !("request_id" in input) ||
    typeof input.request_id !== "string"
  )
    throw new Error("Expected the exact normalized Tool request ID");
  return response(JSON.stringify({ request_id: input.request_id, read_only: true }), {
    inputTokens: 13,
    outputTokens: 4,
  });
}

function errorChain(value: unknown): unknown[] {
  const seen = new Set<unknown>();
  const visit = (current: unknown): void => {
    if (seen.has(current)) return;
    seen.add(current);
    if (current instanceof AggregateError)
      for (const item of current.errors as unknown[]) visit(item);
    if (current instanceof Error && current.cause !== undefined) visit(current.cause);
  };
  visit(value);
  return [...seen];
}

function setup(maxModelRequests = 8, smartApprove = false) {
  const current = snapshot();
  current.deadlineAt = new Date(Date.now() + 60000);
  current.executionSpec.maxModelRequests = maxModelRequests;
  current.executionSpec.modelRetry = { max: 2, baseMs: 1, capMs: 1 };
  if (smartApprove)
    current.executionSpec.configuration = {
      modelProfileId: current.modelProfileId,
      authorizationRevision: 1,
      authorization: { mode: "smart_approve", toolRules: [] },
      digest: "a".repeat(64),
    };
  const events = {
    start: vi.fn<ModelAttemptPort["start"]>().mockResolvedValue(undefined),
    finish: vi.fn<ModelAttemptPort["finish"]>().mockResolvedValue(undefined),
    updatePlan: vi.fn<RunEventPort["updatePlan"]>().mockResolvedValue(true),
    toolProgress: vi.fn<RunEventPort["toolProgress"]>().mockResolvedValue(undefined),
    toolStarted: vi.fn<RunEventPort["toolStarted"]>().mockResolvedValue(undefined),
    toolRejected: vi.fn<RunEventPort["toolRejected"]>().mockResolvedValue(undefined),
    toolFinished: vi.fn<RunEventPort["toolFinished"]>().mockResolvedValue(undefined),
    agentMessage: vi.fn<RunEventPort["agentMessage"]>().mockResolvedValue(undefined),
    agentThought: vi.fn<RunEventPort["agentThought"]>().mockResolvedValue(undefined),
    usage: vi.fn<RunEventPort["usage"]>().mockResolvedValue(undefined),
  } satisfies RunEventPort & ModelAttemptPort;
  const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response());
  const call = vi.fn<ToolCatalogPort["call"]>().mockResolvedValue({
    content: [{ type: "text", text: "/workspace" }],
    isError: false,
    toolEffectState: "none",
    runtimeCallStopped: true,
  });
  const permission = vi.fn<ToolPermissionPort["request"]>().mockResolvedValue({
    decision: "allow_once",
    reason: "explicit user approval",
  });
  const runner = new TurnRunner({
    model: { complete },
    tools: { call },
    permissions: { request: permission },
    events,
    catalog: [
      {
        source: "runtime",
        sourceId: "runtime",
        name: "bash",
        modelName: "bash",
        description: "Execute a command",
        inputSchema: { type: "object" },
      },
    ],
  });
  const input: RunTurnInput = {
    runId: "run-1",
    sessionId: "session-1",
    snapshot: current,
    context: [{ role: "user", content: [{ type: "text", text: "run" }] }],
    signal: new AbortController().signal,
    authoritySignal: new AbortController().signal,
  };
  return { events, complete, call, permission, input, run: () => runner.run(input) };
}

describe("TurnRunner production model retry wiring", () => {
  it("retries one 429 within the original Run and records each usage exactly once through attempt finish", async () => {
    const f = setup();
    f.complete.mockRejectedValueOnce(retryable()).mockResolvedValueOnce(response());
    await expect(f.run()).resolves.toMatchObject({
      terminalClass: "completed",
      executorState: "quiescent",
      stopReason: "end_turn",
    });
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(
      f.events.start.mock.calls.map(([runId, fact]) => [runId, fact.ordinal, fact.purpose]),
    ).toEqual([
      ["run-1", 1, "foreground"],
      ["run-1", 2, "foreground"],
    ]);
    expect(
      f.events.finish.mock.calls.map(([runId, fact]) => ({
        runId,
        ordinal: fact.ordinal,
        outcome: fact.outcome,
        usage: fact.usage,
      })),
    ).toEqual([
      { runId: "run-1", ordinal: 1, outcome: "failed", usage: failedUsage },
      { runId: "run-1", ordinal: 2, outcome: "completed", usage: response().usage },
    ]);
    expect(f.events.agentMessage).toHaveBeenCalledExactlyOnceWith("run-1", [
      { type: "text", text: "done" },
    ]);
    expect(f.events.agentThought).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    expect(f.events.usage).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events.finish.mock.calls)).not.toContain("provider-private-canary");
  });

  it("charges retries against maxModelRequests and ends at max_turn_requests without another Provider or Tool call", async () => {
    const f = setup(2);
    f.complete.mockRejectedValue(retryable());
    await expect(f.run()).resolves.toMatchObject({
      terminalClass: "completed",
      executorState: "quiescent",
      stopReason: "max_turn_requests",
    });
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.events.start.mock.calls.map(([, fact]) => fact.ordinal)).toEqual([1, 2]);
    expect(f.events.finish.mock.calls.map(([, fact]) => fact.outcome)).toEqual([
      "failed",
      "failed",
    ]);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.events.toolStarted).not.toHaveBeenCalled();
    expect(f.events.agentMessage).not.toHaveBeenCalled();
    expect(f.events.usage).not.toHaveBeenCalled();
  });

  it.each([400, 401])("does not retry or dispatch a Tool after HTTP %i", async (status) => {
    const f = setup();
    f.complete.mockRejectedValue(
      new ModelError("model_http_error", "private response", false, status),
    );
    await expect(f.run()).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "model_http_error",
    });
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.events.start).toHaveBeenCalledOnce();
    expect(f.events.finish.mock.calls[0]![1]).toMatchObject({
      ordinal: 1,
      outcome: "failed",
      status,
      usage: {},
    });
    expect(f.call).not.toHaveBeenCalled();
    expect(f.events.usage).not.toHaveBeenCalled();
  });

  it.each(["message", "thought", "tool"] as const)(
    "does not restart the model turn after %s output began",
    async (kind) => {
      const f = setup();
      const error = retryable(503);
      f.complete.mockImplementation(async (request) => {
        if (kind === "tool") error.outputStarted = true;
        else await request.onDelta?.({ kind, text: "partial output" });
        throw error;
      });
      await expect(f.run()).resolves.toMatchObject({
        terminalClass: "failed",
        errorClass: "model_http_error",
      });
      expect(f.complete).toHaveBeenCalledOnce();
      expect(f.events.finish.mock.calls[0]![1]).toMatchObject({
        outcome: "failed",
        outputStarted: true,
        usage: failedUsage,
      });
      if (kind === "message") expect(f.events.agentMessage).toHaveBeenCalledOnce();
      if (kind === "thought") expect(f.events.agentThought).toHaveBeenCalledOnce();
      expect(f.call).not.toHaveBeenCalled();
      expect(f.events.usage).not.toHaveBeenCalled();
    },
  );

  it.each(["start", "failed-finish", "completed-finish"] as const)(
    "propagates %s persistence failure before another Provider call or Tool effect",
    async (phase) => {
      const f = setup();
      const persistence = new RunEventPersistenceError(
        "model attempt",
        new Error("durable write failed"),
      );
      if (phase === "start") f.events.start.mockRejectedValueOnce(persistence);
      else {
        f.events.finish.mockRejectedValueOnce(persistence);
        if (phase === "failed-finish") f.complete.mockRejectedValue(retryable());
        else f.complete.mockResolvedValue(toolResponse());
      }
      const actual: unknown = await f.run().catch((error: unknown) => error);
      expect(errorChain(actual)).toContain(persistence);
      expect(f.complete).toHaveBeenCalledTimes(phase === "start" ? 0 : 1);
      expect(f.call).not.toHaveBeenCalled();
      expect(f.events.toolStarted).not.toHaveBeenCalled();
      expect(f.events.agentMessage).not.toHaveBeenCalled();
      expect(f.events.usage).not.toHaveBeenCalled();
    },
  );

  it("shares ordinals across the main call, a retried smart-approve judge and the final main call", async () => {
    const f = setup(4, true);
    const judgeFailure = retryable();
    f.complete.mockResolvedValueOnce(toolResponse()).mockRejectedValueOnce(judgeFailure);
    f.complete.mockImplementation((request) =>
      Promise.resolve(request.purpose === "permission_judge" ? judgeResponse(request) : response()),
    );
    await expect(f.run()).resolves.toMatchObject({
      terminalClass: "completed",
      stopReason: "end_turn",
    });
    expect(f.complete).toHaveBeenCalledTimes(4);
    expect(f.events.start.mock.calls.map(([, fact]) => [fact.ordinal, fact.purpose])).toEqual([
      [1, "foreground"],
      [2, "permission_judge"],
      [3, "permission_judge"],
      [4, "foreground"],
    ]);
    expect(f.events.finish.mock.calls.map(([, fact]) => [fact.ordinal, fact.outcome])).toEqual([
      [1, "completed"],
      [2, "failed"],
      [3, "completed"],
      [4, "completed"],
    ]);
    expect(f.events.finish.mock.calls[1]![1].usage).toEqual(failedUsage);
    expect(f.complete.mock.calls[1]![0].snapshot.executionSpec.model.maxOutputTokens).toBe(256);
    expect(f.complete.mock.calls[2]![0].snapshot.executionSpec.model.maxOutputTokens).toBe(256);
    expect(f.input.snapshot.executionSpec.model.maxOutputTokens).toBe(4096);
    expect(f.permission).not.toHaveBeenCalled();
    expect(f.call).toHaveBeenCalledOnce();
    expect(f.events.toolStarted).toHaveBeenCalledOnce();
    expect(f.events.toolFinished).toHaveBeenCalledOnce();
    expect(f.events.usage).not.toHaveBeenCalled();
  });

  it("preserves the final main request when a judge retry would consume its reserved slot", async () => {
    const f = setup(3, true);
    f.complete.mockResolvedValueOnce(toolResponse()).mockRejectedValueOnce(retryable());
    f.complete.mockImplementation((request) =>
      Promise.resolve(request.purpose === "permission_judge" ? judgeResponse(request) : response()),
    );
    await expect(f.run()).resolves.toMatchObject({
      terminalClass: "completed",
      stopReason: "end_turn",
    });
    expect(f.complete).toHaveBeenCalledTimes(3);
    expect(f.events.start.mock.calls.map(([, fact]) => [fact.ordinal, fact.purpose])).toEqual([
      [1, "foreground"],
      [2, "permission_judge"],
      [3, "foreground"],
    ]);
    expect(f.events.finish.mock.calls.map(([, fact]) => fact.ordinal)).toEqual([1, 2, 3]);
    expect(f.permission).toHaveBeenCalledOnce();
    expect(f.call).toHaveBeenCalledOnce();
    expect(f.events.usage).not.toHaveBeenCalled();
  });

  it("joins a judge cleanup failure and stops before permission, Tool dispatch or another Provider call", async () => {
    const f = setup(4, true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = new ModelTransportCleanupError(
      new Error("private cleanup sentinel"),
      failedUsage,
    );
    f.complete.mockResolvedValueOnce(toolResponse()).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw cleanup;
    });
    let completed = false;
    const original = f.run().finally(() => {
      completed = true;
    });
    const joined = original.catch(() => undefined);
    try {
      await Promise.race([entered.promise, original]);
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(f.complete).toHaveBeenCalledTimes(2);
      expect(f.events.start).toHaveBeenCalledTimes(2);
      expect(f.events.finish).toHaveBeenCalledOnce();
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      release.resolve();
      await expect(original).resolves.toMatchObject({
        terminalClass: "failed",
        toolEffectState: "none",
      });
      expect(f.complete).toHaveBeenCalledTimes(2);
      expect(f.events.finish.mock.calls[1]![1]).toMatchObject({
        ordinal: 2,
        outcome: "failed",
        reason: "model_cleanup_failed",
        usage: failedUsage,
      });
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      expect(f.events.usage).not.toHaveBeenCalled();
      expect(JSON.stringify(f.events.finish.mock.calls)).not.toContain("private cleanup sentinel");
    } finally {
      release.resolve();
      await joined;
    }
  });

  it("audits a late Tool proposal after the original deadline without dispatching it or renewing admission", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const entered = Promise.withResolvers<void>();
    const received = Promise.withResolvers<ModelResult>();
    const late = toolResponse();
    let original: Promise<unknown> | undefined;
    try {
      vi.setSystemTime(new Date("2026-10-25T00:00:00.000Z"));
      const f = setup();
      f.input.snapshot.deadlineAt = new Date(Date.now() + 50);
      f.complete.mockImplementationOnce(() => {
        entered.resolve();
        // The original Provider deliberately ignores cancellation until its
        // actual response arrives. This is not a second Provider attempt.
        return received.promise;
      });
      let completed = false;
      original = f.run().finally(() => {
        completed = true;
      });
      void original.catch(() => undefined);
      await Promise.race([entered.promise, original]);
      await vi.advanceTimersByTimeAsync(51);
      expect(f.input.signal.aborted).toBe(false);
      expect(f.complete.mock.calls[0]![0].signal.aborted).toBe(true);
      expect(completed).toBe(false);
      expect(f.events.finish).not.toHaveBeenCalled();
      received.resolve(late);
      await expect(original).resolves.toMatchObject({
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: "run_deadline_exceeded",
      });
      expect(f.complete).toHaveBeenCalledOnce();
      expect(f.events.start).toHaveBeenCalledOnce();
      expect(f.events.finish).toHaveBeenCalledOnce();
      expect(f.events.finish.mock.calls[0]![1]).toMatchObject({
        ordinal: 1,
        outcome: "cancelled",
        reason: "deadline_exceeded",
        outputStarted: true,
        usage: late.usage,
      });
      expect(f.events.agentMessage).toHaveBeenCalledOnce();
      const proposals = f.events.agentMessage.mock.calls[0]![2];
      expect(proposals).toHaveLength(1);
      const proposal = proposals?.[0];
      expect(proposal).toMatchObject({
        name: "bash",
        arguments: { command: "pwd" },
      });
      expect(proposal?.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(proposal?.id).not.toBe("provider-call-1");
      expect(f.events.toolRejected).toHaveBeenCalledExactlyOnceWith(
        "run-1",
        proposal,
        expect.any(String),
      );
      expect(f.events.toolStarted).not.toHaveBeenCalled();
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      expect(f.events.usage).not.toHaveBeenCalled();
    } finally {
      received.resolve(late);
      try {
        await Promise.allSettled([received.promise, ...(original === undefined ? [] : [original])]);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("joins ModelOutput and preserves both its persistence failure and an independent Provider cleanup failure", async () => {
    const f = setup();
    const outputSentinel = new Error("output-private-canary");
    const outputFailure = new RunEventPersistenceError("agent message", outputSentinel);
    const cleanupSentinel = new Error("transport-private-canary");
    const cleanupFailure = new ModelTransportCleanupError(cleanupSentinel, failedUsage, true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let modelTask: Promise<ModelResult> | undefined;
    let modelCompleted = false;
    f.events.agentMessage.mockRejectedValue(outputFailure);
    f.complete.mockImplementation((request) => {
      modelTask = (async () => {
        let originalOutputFailure: unknown;
        try {
          await request.onDelta?.({ kind: "message", text: "original visible output" });
        } catch (error) {
          originalOutputFailure = error;
        }
        expect(originalOutputFailure).toBe(outputFailure);
        entered.resolve();
        await release.promise;
        throw cleanupFailure;
      })().finally(() => {
        modelCompleted = true;
      });
      return modelTask;
    });
    let completed = false;
    const original = f.run().finally(() => {
      completed = true;
    });
    const observed = original.catch((error: unknown) => error);
    try {
      await Promise.race([entered.promise, original]);
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(modelCompleted).toBe(false);
      expect(f.events.finish).not.toHaveBeenCalled();
      release.resolve();
      const actual: unknown = await observed;
      expect(actual).toBeInstanceOf(RunEventPersistenceError);
      expect(errorChain(actual)).toContain(outputFailure);
      expect(errorChain(actual)).toContain(outputSentinel);
      expect(errorChain(actual)).toContain(cleanupFailure);
      expect(errorChain(actual)).toContain(cleanupSentinel);
      expect(modelCompleted).toBe(true);
      expect(f.complete).toHaveBeenCalledOnce();
      expect(f.events.agentMessage).toHaveBeenCalledOnce();
      expect(f.events.finish).toHaveBeenCalledOnce();
      expect(f.events.finish.mock.calls[0]![1]).toMatchObject({
        ordinal: 1,
        outcome: "failed",
        reason: "model_cleanup_failed",
        outputStarted: true,
        usage: failedUsage,
      });
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      expect(f.events.toolStarted).not.toHaveBeenCalled();
      expect(f.events.usage).not.toHaveBeenCalled();
      expect(JSON.stringify(f.events.finish.mock.calls)).not.toContain("output-private-canary");
      expect(JSON.stringify(f.events.finish.mock.calls)).not.toContain("transport-private-canary");
    } finally {
      release.resolve();
      await Promise.allSettled([observed, ...(modelTask === undefined ? [] : [modelTask])]);
    }
  });

  it("preserves the escaping Tool-proposal write failure and a different final pending-output failure after cancellation", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const modelEntered = Promise.withResolvers<void>();
    const received = Promise.withResolvers<ModelResult>();
    const flushEntered = Promise.withResolvers<void>();
    const releaseFlush = Promise.withResolvers<void>();
    const late = toolResponse();
    let modelTask: Promise<ModelResult> | undefined;
    let original: Promise<unknown> | undefined;
    try {
      vi.setSystemTime(new Date("2026-10-25T00:00:00.000Z"));
      const f = setup();
      const cancellation = new AbortController();
      f.input.signal = cancellation.signal;
      const proposalSentinel = new Error("proposal-private-canary");
      const proposalFailure = new RunEventPersistenceError("Tool proposal", proposalSentinel);
      const flushSentinel = new Error("pending-flush-private-canary");
      const flushFailure = new RunEventPersistenceError("pending agent message", flushSentinel);
      f.events.agentMessage
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(proposalFailure)
        .mockImplementationOnce(async () => {
          flushEntered.resolve();
          await releaseFlush.promise;
          throw flushFailure;
        });
      let modelCompleted = false;
      f.complete.mockImplementationOnce((request) => {
        modelTask = (async () => {
          await request.onDelta?.({ kind: "message", text: "first successful flush" });
          await request.onDelta?.({ kind: "message", text: "second pending output" });
          modelEntered.resolve();
          return received.promise;
        })().finally(() => {
          modelCompleted = true;
        });
        return modelTask;
      });
      let completed = false;
      original = f.run().finally(() => {
        completed = true;
      });
      const observed = original.catch((error: unknown) => error);
      await Promise.race([modelEntered.promise, original]);
      expect(f.events.agentMessage).toHaveBeenCalledOnce();
      expect(completed).toBe(false);
      cancellation.abort(new Error("cancel before the original Tool response"));
      received.resolve(late);
      await Promise.race([flushEntered.promise, original]);
      expect(modelCompleted).toBe(true);
      expect(completed).toBe(false);
      expect(f.events.agentMessage).toHaveBeenCalledTimes(3);
      expect(f.events.agentMessage.mock.calls[1]![1]).toEqual([]);
      const calls = f.events.agentMessage.mock.calls[1]![2];
      expect(calls).toHaveLength(1);
      expect(calls?.[0]).toMatchObject({ name: "bash", arguments: { command: "pwd" } });
      expect(calls?.[0]?.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(f.events.agentMessage.mock.calls[2]![1]).toEqual([
        { type: "text", text: "second pending output" },
      ]);
      expect(f.events.finish).toHaveBeenCalledOnce();
      expect(f.events.finish.mock.calls[0]![1]).toMatchObject({
        ordinal: 1,
        outcome: "cancelled",
        usage: late.usage,
      });
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      releaseFlush.resolve();
      const actual: unknown = await observed;
      expect(actual).toBeInstanceOf(RunEventPersistenceError);
      expect(errorChain(actual)).toContain(proposalFailure);
      expect(errorChain(actual)).toContain(proposalSentinel);
      expect(errorChain(actual)).toContain(flushFailure);
      expect(errorChain(actual)).toContain(flushSentinel);
      expect(completed).toBe(true);
      expect(f.complete).toHaveBeenCalledOnce();
      expect(f.events.toolStarted).not.toHaveBeenCalled();
      expect(f.events.toolRejected).not.toHaveBeenCalled();
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      expect(f.events.usage).not.toHaveBeenCalled();
    } finally {
      received.resolve(late);
      releaseFlush.resolve();
      try {
        await Promise.allSettled([
          ...(original === undefined ? [] : [original]),
          ...(modelTask === undefined ? [] : [modelTask]),
        ]);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it.each(["foreground", "permission_judge", "after_tool"] as const)(
    "stops on a %s budget rejection without dispatching an unreserved attempt",
    async (stage) => {
      const f = stage === "permission_judge" ? setup(8, true) : setup();
      const denied = new ModelBudgetExceededError("run_cost", "1", "1");
      if (stage === "foreground") {
        f.events.start.mockRejectedValueOnce(denied);
      } else {
        f.complete.mockResolvedValueOnce(toolResponse());
        f.events.start.mockResolvedValueOnce(undefined).mockRejectedValueOnce(denied);
      }
      await expect(f.run()).resolves.toMatchObject({
        terminalClass: "failed",
        executorState: "quiescent",
        errorClass: "budget_exceeded",
      });
      const completedAttempts = stage === "foreground" ? 0 : 1;
      const executedTools = stage === "after_tool" ? 1 : 0;
      expect(f.complete).toHaveBeenCalledTimes(completedAttempts);
      expect(
        f.events.start.mock.calls.map(([runId, fact]) => [runId, fact.ordinal, fact.purpose]),
      ).toEqual(
        stage === "foreground"
          ? [["run-1", 1, "foreground"]]
          : [
              ["run-1", 1, "foreground"],
              ["run-1", 2, stage === "permission_judge" ? "permission_judge" : "foreground"],
            ],
      );
      expect(f.events.finish).toHaveBeenCalledTimes(completedAttempts);
      expect(
        f.events.finish.mock.calls.map(([runId, fact]) => ({
          runId,
          ordinal: fact.ordinal,
          outcome: fact.outcome,
          usage: fact.usage,
        })),
      ).toEqual(
        stage === "foreground"
          ? []
          : [
              {
                runId: "run-1",
                ordinal: 1,
                outcome: "completed",
                usage: toolResponse().usage,
              },
            ],
      );
      expect(f.events.usage).not.toHaveBeenCalled();
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).toHaveBeenCalledTimes(executedTools);
      expect(f.events.toolStarted).toHaveBeenCalledTimes(executedTools);
      expect(f.events.toolFinished).toHaveBeenCalledTimes(executedTools);
      const notice = [
        {
          type: "text",
          text: "Run stopped because the model budget does not permit another call.",
        },
      ];
      expect(f.events.agentMessage).toHaveBeenCalledTimes(stage === "foreground" ? 1 : 2);
      expect(f.events.agentMessage.mock.calls.at(-1)?.slice(0, 2)).toEqual(["run-1", notice]);
      expect(
        f.events.agentMessage.mock.calls.filter(([, content]) =>
          content.some(
            (block) =>
              block.type === "text" &&
              block.text === "Run stopped because the model budget does not permit another call.",
          ),
        ),
      ).toHaveLength(1);
      if (stage === "permission_judge") {
        const proposals = f.events.agentMessage.mock.calls[0]![2];
        expect(proposals).toHaveLength(1);
        const proposal = proposals?.[0];
        expect(proposal).toMatchObject({ name: "bash", arguments: { command: "pwd" } });
        expect(proposal?.id).toMatch(/^[a-f0-9]{64}$/u);
        expect(proposal?.id).not.toBe("provider-call-1");
        expect(f.events.toolRejected).toHaveBeenCalledExactlyOnceWith(
          "run-1",
          proposal,
          expect.any(String),
        );
      } else {
        expect(f.events.toolRejected).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves a budget-notice persistence failure before any model or Tool dispatch", async () => {
    const f = setup();
    const persistence = new RunEventPersistenceError(
      "model budget notice",
      new Error("budget-notice-private-canary"),
    );
    f.events.start.mockRejectedValueOnce(new ModelBudgetExceededError("run_cost", "1", "1"));
    f.events.agentMessage.mockRejectedValueOnce(persistence);
    await expect(f.run()).rejects.toBe(persistence);
    expect(f.events.start).toHaveBeenCalledOnce();
    expect(f.events.finish).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.permission).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    expect(f.events.toolStarted).not.toHaveBeenCalled();
    expect(f.events.toolFinished).not.toHaveBeenCalled();
    expect(f.events.toolRejected).not.toHaveBeenCalled();
    expect(f.events.usage).not.toHaveBeenCalled();
    expect(f.events.agentMessage).toHaveBeenCalledExactlyOnceWith("run-1", [
      { type: "text", text: "Run stopped because the model budget does not permit another call." },
    ]);
  });

  it("retains the original budget-notice persistence failure when authority is lost during its write", async () => {
    const f = setup(8, true);
    const authority = new AbortController();
    const authorityLoss = new Error("original authority loss during budget notice");
    f.input.authoritySignal = authority.signal;
    const entered = Promise.withResolvers<void>();
    const notice = Promise.withResolvers<void>();
    const sentinel = new RunEventPersistenceError(
      "model budget notice",
      new Error("budget-notice-authority-private-canary"),
    );
    f.complete.mockResolvedValueOnce(toolResponse());
    f.events.start
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ModelBudgetExceededError("run_cost", "1", "1"));
    let noticeEntered = false;
    f.events.agentMessage.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      noticeEntered = true;
      entered.resolve();
      return notice.promise;
    });
    let settled = false;
    const original = f.run().finally(() => {
      settled = true;
    });
    const observed = original.catch((error: unknown) => error);
    try {
      await Promise.race([entered.promise, original]);
      expect(noticeEntered).toBe(true);
      expect(settled).toBe(false);
      expect(f.events.agentMessage).toHaveBeenCalledTimes(2);
      expect(f.events.agentMessage.mock.calls[1]![1]).toEqual([
        {
          type: "text",
          text: "Run stopped because the model budget does not permit another call.",
        },
      ]);
      expect(f.complete).toHaveBeenCalledOnce();
      expect(f.events.start).toHaveBeenCalledTimes(2);
      expect(f.events.finish).toHaveBeenCalledOnce();
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      authority.abort(authorityLoss);
      expect(f.input.authoritySignal.reason).toBe(authorityLoss);
      notice.reject(sentinel);
      const actual: unknown = await observed;
      expect(errorChain(actual)).toContain(sentinel);
      expect(settled).toBe(true);
      expect(f.complete).toHaveBeenCalledOnce();
      expect(f.events.start).toHaveBeenCalledTimes(2);
      expect(f.events.finish).toHaveBeenCalledOnce();
      expect(f.events.finish.mock.calls[0]![1]).toMatchObject({
        ordinal: 1,
        outcome: "completed",
        usage: toolResponse().usage,
      });
      expect(f.permission).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      expect(f.events.toolStarted).not.toHaveBeenCalled();
      expect(f.events.toolFinished).not.toHaveBeenCalled();
      expect(f.events.usage).not.toHaveBeenCalled();
    } finally {
      notice.reject(sentinel);
      await Promise.allSettled([notice.promise, original, observed]);
    }
  });
});
