import { describe, expect, it, vi } from "vitest";
import { ModelCallPolicy } from "../../src/application/model-call-policy.js";
import { ModelBudgetExceededError } from "../../src/domain/model-budget.js";
import {
  ModelRequestBudget,
  ModelRequestLimitError,
} from "../../src/application/model-request-budget.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
} from "../../src/ports/model.js";
import type { ModelAttemptPort } from "../../src/ports/model-attempts.js";
import { snapshot } from "../support/fixtures.js";

const wallStart = Date.parse("2026-10-25T00:00:00.000Z");
const failedUsage: ModelUsage = {
  inputTokens: 7,
  outputTokens: 2,
  cost: { amount: 0.000007, currency: "USD", source: "provider_reported" },
};

function success(): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text: "completed" }],
    usage: { inputTokens: 11, outputTokens: 3 },
    stopReason: "end_turn",
  };
}

function failure(status = 429, retryable = true): ModelError {
  return new ModelError("model_http_error", "provider-private-error-canary", retryable, status);
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

function setup(options: { retryMax?: number | null; maxRequests?: number } = {}) {
  let elapsed = 0;
  const advance = (milliseconds: number): void => {
    elapsed += milliseconds;
  };
  const clock = {
    now: () => wallStart + elapsed,
    monotonic: () => elapsed,
    random: vi.fn(() => 0.5),
    wait: vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>(
      (milliseconds, signal) => {
        signal.throwIfAborted();
        advance(milliseconds);
        return Promise.resolve();
      },
    ),
  };
  const model = {
    complete: vi.fn<ModelPort["complete"]>().mockResolvedValue(success()),
  };
  const attempts = {
    start: vi.fn<ModelAttemptPort["start"]>().mockResolvedValue(undefined),
    finish: vi.fn<ModelAttemptPort["finish"]>().mockResolvedValue(undefined),
  };
  const maximum = options.maxRequests ?? 8;
  const budget = new ModelRequestBudget(maximum);
  const policy = new ModelCallPolicy({ model, budget, attempts, clock });
  const abort = new AbortController();
  const request: ModelRequest = {
    snapshot: snapshot(),
    messages: [{ role: "user", content: [{ type: "text", text: "original request" }] }],
    tools: [],
    signal: abort.signal,
  };
  request.snapshot.deadlineAt = new Date(clock.now() + 60000);
  request.snapshot.executionSpec.maxModelRequests = maximum;
  const retryMax = options.retryMax === undefined ? 2 : options.retryMax;
  if (retryMax !== null)
    request.snapshot.executionSpec.modelRetry = { max: retryMax, baseMs: 200, capMs: 30000 };
  return {
    model,
    attempts,
    clock,
    advance,
    budget,
    abort,
    request,
    call: (input: ModelRequest = request) => policy.complete({ runId: "run-1", request: input }),
  };
}

describe("Run model call policy", () => {
  it("preserves a budget refusal before transport without retrying or manufacturing finish usage", async () => {
    const f = setup({ retryMax: 8 });
    const denied = new ModelBudgetExceededError("run_input", "100", "100");
    f.attempts.start.mockRejectedValue(denied);
    await expect(f.call()).rejects.toBe(denied);
    expect(f.attempts.start).toHaveBeenCalledOnce();
    expect(f.model.complete).not.toHaveBeenCalled();
    expect(f.attempts.finish).not.toHaveBeenCalled();
    expect(f.clock.wait).not.toHaveBeenCalled();
  });

  it("honors Retry-After and records both original attempts and their distinct usage", async () => {
    const f = setup();
    const first = failure();
    first.retryAfterMs = 2000;
    first.usage = structuredClone(failedUsage);
    const result = success();
    f.model.complete
      .mockImplementationOnce(() => {
        f.advance(25);
        return Promise.reject(first);
      })
      .mockImplementationOnce(() => {
        f.advance(40);
        return Promise.resolve(result);
      });
    await expect(f.call()).resolves.toEqual(result);
    expect(f.model.complete).toHaveBeenCalledTimes(2);
    expect(f.clock.wait).toHaveBeenCalledOnce();
    expect(f.clock.wait.mock.calls[0]![0]).toBe(2000);
    expect(
      f.attempts.start.mock.calls.map(([runId, fact]) => ({
        runId,
        ordinal: fact.ordinal,
        modelProfileId: fact.modelProfileId,
        providerConnectionId: fact.providerConnectionId,
        model: fact.model,
        purpose: fact.purpose,
      })),
    ).toEqual(
      [1, 2].map((ordinal) => ({
        runId: "run-1",
        ordinal,
        modelProfileId: "profile-1",
        providerConnectionId: "connection-1",
        model: "example-model",
        purpose: "foreground",
      })),
    );
    expect(
      f.attempts.finish.mock.calls.map(([runId, fact]) => ({
        runId,
        ordinal: fact.ordinal,
        outcome: fact.outcome,
        usage: fact.usage,
        outputStarted: fact.outputStarted,
        durationMs: fact.durationMs,
      })),
    ).toEqual([
      {
        runId: "run-1",
        ordinal: 1,
        outcome: "failed",
        usage: failedUsage,
        outputStarted: false,
        durationMs: 25,
      },
      {
        runId: "run-1",
        ordinal: 2,
        outcome: "completed",
        usage: result.usage,
        outputStarted: true,
        durationMs: 40,
      },
    ]);
    expect(f.attempts.finish.mock.calls[0]![1]).toHaveProperty("status", 429);
    for (const [, fact] of f.attempts.start.mock.calls) expect(fact.startedAt).toBeInstanceOf(Date);
    for (const [, fact] of f.attempts.finish.mock.calls) {
      expect(fact.finishedAt).toBeInstanceOf(Date);
      expect(fact.reason).toEqual(expect.any(String));
    }
    for (const [request] of f.model.complete.mock.calls) {
      expect(request.snapshot).toStrictEqual(f.request.snapshot);
      expect(request.messages).toStrictEqual(f.request.messages);
      expect(request.tools).toStrictEqual(f.request.tools);
    }
    expect(JSON.stringify(f.attempts.finish.mock.calls)).not.toContain(
      "provider-private-error-canary",
    );
  });

  it("uses bounded exponential full jitter for the original retry chain", async () => {
    const f = setup({ retryMax: 3 });
    f.request.snapshot.executionSpec.modelRetry = { max: 3, baseMs: 200, capMs: 500 };
    const error = failure(503);
    f.model.complete.mockRejectedValue(error);
    await expect(f.call()).rejects.toBe(error);
    expect(f.model.complete).toHaveBeenCalledTimes(4);
    expect(f.clock.wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 200, 250]);
  });

  it.each([
    { label: "omitted policy", retryMax: null },
    { label: "explicit zero", retryMax: 0 },
  ])("preserves zero retries for $label", async ({ retryMax }) => {
    const f = setup({ retryMax });
    const error = failure();
    f.model.complete.mockRejectedValue(error);
    await expect(f.call()).rejects.toBe(error);
    expect(f.model.complete).toHaveBeenCalledOnce();
    expect(f.clock.wait).not.toHaveBeenCalled();
    expect(f.attempts.finish).toHaveBeenCalledOnce();
  });

  it("counts max as retries after the first attempt and preserves the final failure", async () => {
    const f = setup({ retryMax: 2 });
    const errors = [failure(503), failure(503), failure(503)];
    for (const error of errors) f.model.complete.mockRejectedValueOnce(error);
    await expect(f.call()).rejects.toBe(errors[2]);
    expect(f.model.complete).toHaveBeenCalledTimes(3);
    expect(f.attempts.start.mock.calls.map(([, fact]) => fact.ordinal)).toEqual([1, 2, 3]);
    expect(f.attempts.finish.mock.calls.map(([, fact]) => fact.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
  });

  it.each([400, 401])("does not retry non-retryable HTTP %i", async (status) => {
    const f = setup();
    const error = failure(status, false);
    f.model.complete.mockRejectedValue(error);
    await expect(f.call()).rejects.toBe(error);
    expect(f.model.complete).toHaveBeenCalledOnce();
    expect(f.clock.wait).not.toHaveBeenCalled();
    expect(f.attempts.finish.mock.calls[0]![1]).toMatchObject({
      outcome: "failed",
      outputStarted: false,
      status,
      usage: {},
    });
  });

  it.each([
    new Error("unknown-private-canary"),
    { code: "model_http_error", retryable: true, status: 429, message: "unknown-private-canary" },
  ])("does not infer retry authority from an unknown failure: %j", async (error) => {
    const f = setup();
    f.model.complete.mockRejectedValue(error);
    await expect(f.call()).rejects.toBe(error);
    expect(f.model.complete).toHaveBeenCalledOnce();
    expect(f.clock.wait).not.toHaveBeenCalled();
    expect(f.attempts.finish.mock.calls[0]![1]).toMatchObject({
      outcome: "failed",
      usage: {},
      outputStarted: false,
    });
    expect(JSON.stringify(f.attempts.finish.mock.calls)).not.toContain("unknown-private-canary");
  });

  it.each(["message", "thought", "tool"] as const)(
    "never retries after nonempty %s output",
    async (kind) => {
      const f = setup();
      const error = failure(503);
      const delta = vi.fn<NonNullable<ModelRequest["onDelta"]>>().mockResolvedValue(undefined);
      f.request.onDelta = delta;
      f.model.complete.mockImplementation(async (request) => {
        if (kind === "tool") error.outputStarted = true;
        else await request.onDelta?.({ kind, text: "visible output" });
        throw error;
      });
      await expect(f.call()).rejects.toBe(error);
      expect(f.model.complete).toHaveBeenCalledOnce();
      expect(f.clock.wait).not.toHaveBeenCalled();
      if (kind !== "tool") expect(delta).toHaveBeenCalledWith({ kind, text: "visible output" });
      expect(f.attempts.finish.mock.calls[0]![1]).toMatchObject({
        outcome: "failed",
        outputStarted: true,
      });
    },
  );

  it("does not dispatch another attempt until the original complete promise settles", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = failure();
    f.model.complete.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw first;
    });
    let completed = false;
    const original = f.call().finally(() => {
      completed = true;
    });
    const joined = original.catch(() => undefined);
    try {
      await Promise.race([entered.promise, original]);
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(f.model.complete).toHaveBeenCalledOnce();
      expect(f.attempts.finish).not.toHaveBeenCalled();
      release.resolve();
      await expect(original).resolves.toEqual(success());
      expect(f.model.complete).toHaveBeenCalledTimes(2);
      expect(f.attempts.finish).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await joined;
    }
  });

  it("joins held original cleanup and preserves its independent failure without retry", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sentinel = new Error("cleanup-private-canary");
    const error = new ModelTransportCleanupError(sentinel, failedUsage);
    f.model.complete.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw error;
    });
    let completed = false;
    const original = f.call().finally(() => {
      completed = true;
    });
    const observed = original.catch((failure: unknown) => failure);
    try {
      await Promise.race([entered.promise, original]);
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(f.attempts.finish).not.toHaveBeenCalled();
      release.resolve();
      const actual = await observed;
      expect(errorChain(actual)).toContain(sentinel);
      expect(f.model.complete).toHaveBeenCalledOnce();
      expect(f.clock.wait).not.toHaveBeenCalled();
      expect(f.attempts.finish.mock.calls[0]![1]).toMatchObject({
        outcome: "failed",
        usage: failedUsage,
      });
      expect(JSON.stringify(f.attempts.finish.mock.calls)).not.toContain("cleanup-private-canary");
    } finally {
      release.resolve();
      await observed;
    }
  });

  it("cancels backoff without detaching its original wait or sending another attempt", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reason = new Error("Run was cancelled during backoff");
    f.model.complete.mockRejectedValue(failure());
    f.clock.wait.mockImplementationOnce(async (_milliseconds, signal) => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
    });
    let completed = false;
    const original = f.call().finally(() => {
      completed = true;
    });
    const observed = original.catch((error: unknown) => error);
    try {
      await Promise.race([entered.promise, original]);
      f.abort.abort(reason);
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(f.model.complete).toHaveBeenCalledOnce();
      release.resolve();
      expect(errorChain(await observed)).toContain(reason);
      expect(f.model.complete).toHaveBeenCalledOnce();
    } finally {
      f.abort.abort(reason);
      release.resolve();
      await observed;
    }
  });

  it("never renews the original Run deadline to honor a longer Retry-After", async () => {
    const f = setup();
    f.request.snapshot.deadlineAt = new Date(f.clock.now() + 50);
    const error = failure();
    error.retryAfterMs = 2000;
    f.model.complete.mockRejectedValue(error);
    await expect(f.call()).rejects.toBeInstanceOf(Error);
    expect(f.model.complete).toHaveBeenCalledOnce();
    expect(f.clock.monotonic()).toBeLessThanOrEqual(50);
    expect(f.attempts.finish).toHaveBeenCalledOnce();
  });

  it("does not admit a provider call after the original deadline already expired", async () => {
    const f = setup();
    f.advance(60001);
    await expect(f.call()).rejects.toBeInstanceOf(Error);
    expect(f.model.complete).not.toHaveBeenCalled();
    expect(f.attempts.start).not.toHaveBeenCalled();
    expect(f.clock.wait).not.toHaveBeenCalled();
  });

  it("does not dispatch when the post-start input copy reaches the original deadline", async () => {
    const f = setup();
    const deadline = f.request.snapshot.deadlineAt.getTime();
    const originalClone = globalThis.structuredClone;
    let copies = 0;
    let copiedAfterStart = false;
    const copy: typeof structuredClone = (value, options) => {
      const result = originalClone(value, options);
      copies++;
      if (copies === 2) {
        copiedAfterStart = f.attempts.start.mock.calls.length === 1;
        f.advance(deadline - f.clock.now());
      }
      return result;
    };
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementation(copy);
    try {
      await expect(f.call()).rejects.toBeInstanceOf(Error);
      expect(copiedAfterStart).toBe(true);
      expect(f.attempts.start).toHaveBeenCalledOnce();
      expect(f.model.complete).not.toHaveBeenCalled();
      expect(f.attempts.finish).toHaveBeenCalledOnce();
      expect(f.attempts.finish.mock.calls[0]![1]).toMatchObject({
        ordinal: 1,
        outcome: "cancelled",
        reason: "deadline_exceeded",
        outputStarted: false,
        usage: {},
      });
      expect(f.clock.wait).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it.each(["start", "failed-finish", "completed-finish"] as const)(
    "does not continue after %s persistence fails",
    async (phase) => {
      const f = setup();
      const persistence = new Error("attempt persistence failed");
      const modelFailure = failure();
      if (phase === "start") f.attempts.start.mockRejectedValueOnce(persistence);
      else {
        f.attempts.finish.mockRejectedValueOnce(persistence);
        if (phase === "failed-finish") f.model.complete.mockRejectedValue(modelFailure);
      }
      const actual: unknown = await f.call().catch((error: unknown) => error);
      expect(errorChain(actual)).toContain(persistence);
      expect(f.model.complete).toHaveBeenCalledTimes(phase === "start" ? 0 : 1);
      expect(f.clock.wait).not.toHaveBeenCalled();
    },
  );

  it("shares physical-attempt ordinals across foreground, judge retries and the following foreground call", async () => {
    const f = setup({ maxRequests: 4 });
    f.model.complete
      .mockResolvedValueOnce(success())
      .mockRejectedValueOnce(failure())
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success());
    await f.call();
    await f.call({ ...f.request, purpose: "permission_judge" });
    await f.call();
    expect(f.model.complete).toHaveBeenCalledTimes(4);
    expect(f.attempts.start.mock.calls.map(([, fact]) => [fact.ordinal, fact.purpose])).toEqual([
      [1, "foreground"],
      [2, "permission_judge"],
      [3, "permission_judge"],
      [4, "foreground"],
    ]);
    expect(f.attempts.finish.mock.calls.map(([, fact]) => fact.ordinal)).toEqual([1, 2, 3, 4]);
    await expect(f.call()).rejects.toBeInstanceOf(ModelRequestLimitError);
    expect(f.model.complete).toHaveBeenCalledTimes(4);
  });

  it("does not let a judge consume the final shared foreground request", async () => {
    const f = setup({ maxRequests: 3 });
    f.model.complete.mockRejectedValueOnce(failure()).mockResolvedValue(success());
    await f.call();
    await expect(f.call({ ...f.request, purpose: "permission_judge" })).rejects.toBeInstanceOf(
      ModelRequestLimitError,
    );
    expect(f.model.complete).toHaveBeenCalledTimes(2);
    await f.call();
    expect(f.model.complete).toHaveBeenCalledTimes(3);
    expect(f.attempts.start.mock.calls.map(([, fact]) => [fact.ordinal, fact.purpose])).toEqual([
      [1, "foreground"],
      [2, "foreground"],
      [3, "foreground"],
    ]);
  });

  it("exhausts the shared model request budget before the configured retry maximum", async () => {
    const f = setup({ retryMax: 8, maxRequests: 2 });
    f.model.complete.mockRejectedValue(failure());
    await expect(f.call()).rejects.toBeInstanceOf(ModelRequestLimitError);
    expect(f.model.complete).toHaveBeenCalledTimes(2);
    expect(f.attempts.start).toHaveBeenCalledTimes(2);
    expect(f.attempts.finish).toHaveBeenCalledTimes(2);
  });

  it("bounds the entire judge retry chain to one ten-second budget", async () => {
    const f = setup({ retryMax: 8, maxRequests: 16 });
    const error = failure();
    error.retryAfterMs = 6000;
    f.model.complete.mockRejectedValue(error);
    await expect(f.call({ ...f.request, purpose: "permission_judge" })).rejects.toBeInstanceOf(
      Error,
    );
    expect(f.model.complete).toHaveBeenCalledTimes(2);
    expect(f.clock.monotonic()).toBeLessThanOrEqual(10000);
    expect(f.attempts.finish).toHaveBeenCalledTimes(2);
  });

  it("joins an aborted original provider task, records its usage and never retries it", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reason = new Error("original cancellation reason");
    const error = new ModelError("model_unavailable", "cancelled model work", true, undefined, {
      cause: reason,
    });
    error.usage = failedUsage;
    f.model.complete.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw error;
    });
    let completed = false;
    const original = f.call().finally(() => {
      completed = true;
    });
    const observed = original.catch((failure: unknown) => failure);
    try {
      await Promise.race([entered.promise, original]);
      f.abort.abort(reason);
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(f.attempts.finish).not.toHaveBeenCalled();
      release.resolve();
      expect(errorChain(await observed)).toContain(reason);
      expect(f.model.complete).toHaveBeenCalledOnce();
      expect(f.clock.wait).not.toHaveBeenCalled();
      expect(f.attempts.finish.mock.calls[0]![1]).toMatchObject({
        outcome: "cancelled",
        usage: failedUsage,
      });
    } finally {
      f.abort.abort(reason);
      release.resolve();
      await observed;
    }
  });
});
