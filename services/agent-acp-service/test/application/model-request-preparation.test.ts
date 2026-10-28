import { describe, expect, it, vi } from "vitest";
import { ModelCallPolicy } from "../../src/application/model-call-policy.js";
import { ModelRequestBudget } from "../../src/application/model-request-budget.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { ModelBudgetExceededError } from "../../src/domain/model-budget.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
} from "../../src/ports/model.js";
import type { ModelAttemptPort } from "../../src/ports/model-attempts.js";
import { snapshot } from "../support/fixtures.js";

const wallStart = Date.parse("2026-10-25T00:00:00.000Z");

function result(): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text: "completed" }],
    stopReason: "end_turn",
    usage: { inputTokens: 7, outputTokens: 2 },
  };
}

function prepared(reservation: { inputTokens?: number; outputTokens?: number }) {
  return {
    reservation,
    complete: vi.fn<() => Promise<ModelResult>>().mockResolvedValue(result()),
    release: vi.fn<() => void>(),
  };
}

function preparingModel(...calls: ReturnType<typeof prepared>[]) {
  const prepare = vi.fn<(request: ModelRequest) => ReturnType<typeof prepared>>();
  for (const call of calls) prepare.mockReturnValueOnce(call);
  return {
    prepare,
    complete: vi
      .fn<ModelPort["complete"]>()
      .mockRejectedValue(new Error("Prepared calls must not use the complete-only entry point")),
  };
}

function setup(model: ModelPort) {
  let elapsed = 0;
  const clock = {
    now: () => wallStart + elapsed,
    monotonic: () => elapsed,
    random: () => 0.5,
    wait: vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>(
      (milliseconds, signal) => {
        signal.throwIfAborted();
        elapsed += milliseconds;
        return Promise.resolve();
      },
    ),
  };
  const attempts = {
    start: vi.fn<ModelAttemptPort["start"]>().mockResolvedValue(undefined),
    finish: vi.fn<ModelAttemptPort["finish"]>().mockResolvedValue(undefined),
  };
  const request: ModelRequest = {
    snapshot: snapshot(),
    messages: [{ role: "user", content: [{ type: "text", text: "original request" }] }],
    tools: [],
    signal: new AbortController().signal,
  };
  request.snapshot.deadlineAt = new Date(wallStart + 60_000);
  request.snapshot.executionSpec.maxModelRequests = 8;
  request.snapshot.executionSpec.modelRetry = { max: 1, baseMs: 200, capMs: 30_000 };
  const policy = new ModelCallPolicy({
    model,
    attempts,
    budget: new ModelRequestBudget(8),
    clock,
  });
  return {
    request,
    attempts,
    clock,
    call: () => policy.complete({ runId: "run-1", request }),
  };
}

describe("ModelCallPolicy prepared request lifecycle", () => {
  it("keeps a no-dispatch cleanup failure blocking after releasing its monetary liability", async () => {
    const failure = new ModelTransportCleanupError(new Error("original transport close failed"));
    const call = { ...prepared({}), dispatchState: "not_dispatched" as const };
    call.complete.mockRejectedValueOnce(failure);
    const f = setup(preparingModel(call));
    await expect(f.call()).rejects.toBe(failure);
    expect(f.attempts.finish).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        notDispatched: true,
        outcome: "failed",
        reason: "model_cleanup_failed",
      }),
    );
    expect(call.complete).toHaveBeenCalledOnce();
    expect(call.release).toHaveBeenCalledOnce();
  });

  it("never replaces contradictory original Provider usage with a zero-dispatch receipt", async () => {
    const failure = new ModelError("model_unavailable", "original usage survived", false);
    failure.usage = { inputTokens: 3, outputTokens: 2 };
    const call = { ...prepared({}), dispatchState: "not_dispatched" as const };
    call.complete.mockRejectedValueOnce(failure);
    const f = setup(preparingModel(call));
    await expect(f.call()).rejects.toBe(failure);
    expect(f.attempts.finish.mock.calls[0]![1].usage).toEqual(failure.usage);
    expect(f.attempts.finish.mock.calls[0]![1]).not.toHaveProperty("notDispatched");
  });

  it("records no dispatch when cancellation arrives with the committed start receipt", async () => {
    const call = prepared({ inputTokens: 19, outputTokens: 5 });
    const f = setup(preparingModel(call));
    const stop = new AbortController();
    const cancelled = new Error("cancelled after original start commit");
    f.request.signal = stop.signal;
    f.attempts.start.mockImplementationOnce(() => {
      stop.abort(cancelled);
      return Promise.resolve();
    });
    await expect(f.call()).rejects.toBe(cancelled);
    expect(call.complete).not.toHaveBeenCalled();
    expect(f.attempts.finish).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        outcome: "cancelled",
        notDispatched: true,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    expect(call.release).toHaveBeenCalledOnce();
  });

  it.each(["not_dispatched", "possibly_dispatched", undefined] as const)(
    "settles only the joined original dispatch state %s",
    async (dispatchState) => {
      const gate = Promise.withResolvers<ModelResult>();
      const entered = Promise.withResolvers<void>();
      const failure = new Error("original preparation or send failed");
      const call = { ...prepared({ inputTokens: 19, outputTokens: 5 }), dispatchState };
      call.complete.mockImplementationOnce(() => {
        entered.resolve();
        return gate.promise;
      });
      const f = setup(preparingModel(call));
      const original = f.call();
      void original.catch(() => undefined);
      try {
        await entered.promise;
        expect(f.attempts.finish).not.toHaveBeenCalled();
        expect(call.release).not.toHaveBeenCalled();
        gate.reject(failure);
        await expect(original).rejects.toBe(failure);
        const finish = f.attempts.finish.mock.calls[0]![1];
        if (dispatchState === "not_dispatched") {
          expect(finish).toMatchObject({
            notDispatched: true,
            usage: { inputTokens: 0, outputTokens: 0 },
          });
          expect(finish.usage).not.toHaveProperty("cost");
        } else {
          expect(finish).not.toHaveProperty("notDispatched");
          expect(finish.usage).toEqual({});
        }
      } finally {
        gate.reject(failure);
        await original.catch(() => undefined);
      }
      expect(call.release).toHaveBeenCalledOnce();
    },
  );

  it("confirms a copied reservation before dispatch and releases only after the original finish", async () => {
    const order: string[] = [];
    const bounds = { inputTokens: 19, outputTokens: 5 };
    const call = prepared(bounds);
    call.complete.mockImplementation(() => {
      order.push("complete");
      return Promise.resolve(result());
    });
    call.release.mockImplementation(() => {
      order.push("release");
    });
    const model = preparingModel(call);
    model.prepare.mockReset().mockImplementationOnce(() => {
      order.push("prepare");
      return call;
    });
    const f = setup(model);
    const entered = Promise.withResolvers<void>();
    const confirm = Promise.withResolvers<void>();
    f.attempts.start.mockImplementationOnce(() => {
      order.push("start");
      entered.resolve();
      return confirm.promise;
    });
    f.attempts.finish.mockImplementationOnce(() => {
      order.push("finish");
      return Promise.resolve();
    });
    const original = f.call();
    const observed = original.catch((error: unknown) => error);
    try {
      await Promise.race([entered.promise, original]);
      expect(order).toEqual(["prepare", "start"]);
      expect(call.complete).not.toHaveBeenCalled();
      expect(call.release).not.toHaveBeenCalled();
      expect(f.attempts.start.mock.calls[0]![1]).toMatchObject({
        ordinal: 1,
        reservation: { inputTokens: 19, outputTokens: 5 },
      });
      expect(f.attempts.start.mock.calls[0]![1].reservation).not.toBe(bounds);
      confirm.resolve();
      await expect(original).resolves.toEqual(result());
      expect(order).toEqual(["prepare", "start", "complete", "finish", "release"]);
      bounds.inputTokens = 999;
      expect(f.attempts.start.mock.calls[0]![1].reservation).toEqual({
        inputTokens: 19,
        outputTokens: 5,
      });
      expect(model.prepare).toHaveBeenCalledOnce();
      expect(model.complete).not.toHaveBeenCalled();
      expect(call.complete).toHaveBeenCalledOnce();
      expect(call.release).toHaveBeenCalledOnce();
      expect(f.attempts.finish).toHaveBeenCalledOnce();
    } finally {
      confirm.resolve();
      await Promise.allSettled([confirm.promise, original, observed]);
    }
  });

  it("releases a prepared call on a typed budget refusal without dispatch or a fabricated finish", async () => {
    const call = prepared({ inputTokens: 19, outputTokens: 5 });
    const model = preparingModel(call);
    const f = setup(model);
    const denied = new ModelBudgetExceededError("run_cost", "1", "1");
    f.attempts.start.mockRejectedValueOnce(denied);
    await expect(f.call()).rejects.toBe(denied);
    expect(model.prepare).toHaveBeenCalledOnce();
    expect(f.attempts.start).toHaveBeenCalledOnce();
    expect(f.attempts.start.mock.calls[0]![1].reservation).toEqual(call.reservation);
    expect(call.complete).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
    expect(f.attempts.finish).not.toHaveBeenCalled();
    expect(call.release).toHaveBeenCalledOnce();
    expect(f.clock.wait).not.toHaveBeenCalled();
  });

  it("releases the prepared call while preserving an ordinary start-persistence failure", async () => {
    const call = prepared({ inputTokens: 19 });
    const model = preparingModel(call);
    const f = setup(model);
    const failure = new Error("original-start-persistence-canary");
    f.attempts.start.mockRejectedValueOnce(failure);
    const actual: unknown = await f.call().catch((error: unknown) => error);
    expect(actual).toBeInstanceOf(RunEventPersistenceError);
    expect(actual).toMatchObject({ cause: failure });
    expect(model.prepare).toHaveBeenCalledOnce();
    expect(f.attempts.start).toHaveBeenCalledOnce();
    expect(call.complete).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
    expect(f.attempts.finish).not.toHaveBeenCalled();
    expect(call.release).toHaveBeenCalledOnce();
    expect(f.clock.wait).not.toHaveBeenCalled();
  });

  it("keeps the original prepared call retained until its complete promise actually settles", async () => {
    const call = prepared({ inputTokens: 19, outputTokens: 5 });
    const model = preparingModel(call);
    const f = setup(model);
    const entered = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<ModelResult>();
    call.complete.mockImplementationOnce(() => {
      entered.resolve();
      return completed.promise;
    });
    let settled = false;
    const original = f.call().finally(() => {
      settled = true;
    });
    const observed = original.catch((error: unknown) => error);
    try {
      await Promise.race([entered.promise, original]);
      expect(settled).toBe(false);
      expect(call.complete).toHaveBeenCalledOnce();
      expect(call.release).not.toHaveBeenCalled();
      expect(f.attempts.finish).not.toHaveBeenCalled();
      completed.resolve(result());
      await expect(original).resolves.toEqual(result());
      expect(settled).toBe(true);
      expect(f.attempts.finish).toHaveBeenCalledOnce();
      expect(call.release).toHaveBeenCalledOnce();
      expect(model.complete).not.toHaveBeenCalled();
    } finally {
      completed.resolve(result());
      await Promise.allSettled([completed.promise, original, observed]);
    }
  });

  it("prepares each retry with fresh bounds and preserves unknown reservation for complete-only models", async () => {
    const first = prepared({ inputTokens: 19, outputTokens: 5 });
    const second = prepared({ inputTokens: 23, outputTokens: 7 });
    const failure = new ModelError("model_http_error", "transient", true, 429);
    failure.retryAfterMs = 2000;
    first.complete.mockRejectedValueOnce(failure);
    const model = preparingModel(first, second);
    const f = setup(model);
    await expect(f.call()).resolves.toEqual(result());
    expect(model.prepare).toHaveBeenCalledTimes(2);
    expect(model.complete).not.toHaveBeenCalled();
    expect(first.complete).toHaveBeenCalledOnce();
    expect(second.complete).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
    expect(
      f.attempts.start.mock.calls.map(([, fact]) => ({
        ordinal: fact.ordinal,
        reservation: fact.reservation,
      })),
    ).toEqual([
      { ordinal: 1, reservation: { inputTokens: 19, outputTokens: 5 } },
      { ordinal: 2, reservation: { inputTokens: 23, outputTokens: 7 } },
    ]);
    expect(f.attempts.finish.mock.calls.map(([, fact]) => [fact.ordinal, fact.outcome])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect(f.clock.wait).toHaveBeenCalledOnce();
    expect(f.clock.wait.mock.calls[0]![0]).toBe(2000);
    for (const [request] of model.prepare.mock.calls)
      expect(request.snapshot.deadlineAt).toEqual(new Date(wallStart + 60_000));

    const legacy = { complete: vi.fn<ModelPort["complete"]>().mockResolvedValue(result()) };
    const old = setup(legacy);
    await expect(old.call()).resolves.toEqual(result());
    expect(legacy.complete).toHaveBeenCalledOnce();
    expect(old.attempts.start).toHaveBeenCalledOnce();
    expect(Object.hasOwn(old.attempts.start.mock.calls[0]![1], "reservation")).toBe(false);
    expect(old.attempts.finish).toHaveBeenCalledOnce();
  });

  it.each(["foreground", "permission_judge"] as const)(
    "prepares the actual fallback candidate with the %s output cap",
    async (purpose) => {
      const first = prepared({
        inputTokens: 19,
        outputTokens: purpose === "foreground" ? 4096 : 256,
      });
      const second = prepared({
        inputTokens: 23,
        outputTokens: purpose === "foreground" ? 512 : 256,
      });
      first.complete.mockRejectedValueOnce(
        new ModelError("model_http_error", "transient", true, 503),
      );
      const model = preparingModel(first, second);
      const f = setup(model);
      if (purpose === "permission_judge") f.request.purpose = purpose;
      f.request.snapshot.executionSpec.modelRetry = { max: 0, baseMs: 200, capMs: 30_000 };
      f.request.snapshot.executionSpec.modelFailover = "before_output";
      f.request.snapshot.executionSpec.model.temperature = 0.7;
      f.request.snapshot.executionSpec.fallbackModels = [
        {
          modelProfileId: "profile-b",
          providerConnectionId: "connection-b",
          model: {
            ...structuredClone(f.request.snapshot.executionSpec.model),
            baseUrl: "https://provider-b.example.test/v1",
            model: "model-b",
            contextWindow: 32_000,
            maxOutputTokens: 512,
            temperature: 0.4,
          },
        },
      ];
      const originalSnapshot = structuredClone(f.request.snapshot);
      await expect(f.call()).resolves.toEqual(result());
      expect(model.prepare).toHaveBeenCalledTimes(2);
      expect(model.complete).not.toHaveBeenCalled();
      expect(
        model.prepare.mock.calls.map(([request]) => ({
          profile: request.snapshot.modelProfileId,
          provider: request.snapshot.providerConnectionId,
          model: request.snapshot.executionSpec.model.model,
          maxOutput: request.snapshot.executionSpec.model.maxOutputTokens,
          temperature: request.snapshot.executionSpec.model.temperature,
          purpose: request.purpose,
          deadlineAt: request.snapshot.deadlineAt,
        })),
      ).toEqual([
        {
          profile: "profile-1",
          provider: "connection-1",
          model: "example-model",
          maxOutput: purpose === "foreground" ? 4096 : 256,
          temperature: purpose === "foreground" ? 0.7 : 0,
          purpose: purpose === "foreground" ? undefined : "permission_judge",
          deadlineAt: new Date(wallStart + 60_000),
        },
        {
          profile: "profile-b",
          provider: "connection-b",
          model: "model-b",
          maxOutput: purpose === "foreground" ? 512 : 256,
          temperature: purpose === "foreground" ? 0.4 : 0,
          purpose: purpose === "foreground" ? undefined : "permission_judge",
          deadlineAt: new Date(wallStart + 60_000),
        },
      ]);
      expect(
        f.attempts.start.mock.calls.map(([, fact]) => ({
          ordinal: fact.ordinal,
          profile: fact.modelProfileId,
          provider: fact.providerConnectionId,
          purpose: fact.purpose,
          reservation: fact.reservation,
        })),
      ).toEqual([
        {
          ordinal: 1,
          profile: "profile-1",
          provider: "connection-1",
          purpose,
          reservation: first.reservation,
        },
        {
          ordinal: 2,
          profile: "profile-b",
          provider: "connection-b",
          purpose,
          reservation: second.reservation,
        },
      ]);
      expect(first.complete).toHaveBeenCalledOnce();
      expect(second.complete).toHaveBeenCalledOnce();
      expect(first.release).toHaveBeenCalledOnce();
      expect(second.release).toHaveBeenCalledOnce();
      expect(f.attempts.finish).toHaveBeenCalledTimes(2);
      expect(f.clock.wait).not.toHaveBeenCalled();
      expect(f.request.snapshot).toEqual(originalSnapshot);
    },
  );
});
