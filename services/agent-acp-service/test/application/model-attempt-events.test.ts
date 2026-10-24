import { describe, expect, it, vi } from "vitest";

import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import { ModelBudgetExceededError } from "../../src/domain/model-budget.js";
import {
  DurableRunEvents,
  RunEventPersistenceError,
} from "../../src/application/durable-run-events.js";
import type { ResourceIdGenerator } from "../../src/domain/resource-id.js";
import type { SessionEvent, SessionEventPublisher } from "../../src/ports/acp-application.js";
import type { ModelAttemptFinished, ModelAttemptStarted } from "../../src/ports/model-attempts.js";
import type {
  FinishModelAttemptInput,
  RunEventRepository,
  StartModelAttemptInput,
} from "../../src/ports/run-event-repository.js";

const cases = [
  { operation: "start", repositoryMethod: "startModelAttempt" },
  { operation: "finish", repositoryMethod: "finishModelAttempt" },
] as const;
type Operation = (typeof cases)[number]["operation"];
type WriteInput = StartModelAttemptInput | FinishModelAttemptInput;

function setup() {
  const ownership = new AbortController();
  const receipt: SessionEvent = { kind: "usage", used: 9, size: 64_000 };
  const repository = {
    startModelAttempt: vi
      .fn<RunEventRepository["startModelAttempt"]>()
      .mockResolvedValue(undefined),
    finishModelAttempt: vi
      .fn<RunEventRepository["finishModelAttempt"]>()
      .mockResolvedValue(receipt),
    appendPlan: vi.fn<RunEventRepository["appendPlan"]>(),
    appendAgentMessage: vi.fn<RunEventRepository["appendAgentMessage"]>(),
    appendAgentThought: vi.fn<RunEventRepository["appendAgentThought"]>(),
    appendToolProgress: vi.fn<RunEventRepository["appendToolProgress"]>(),
    appendRejectedToolCall: vi.fn<RunEventRepository["appendRejectedToolCall"]>(),
    appendUsage: vi.fn<RunEventRepository["appendUsage"]>(),
    startToolAttempt: vi.fn<RunEventRepository["startToolAttempt"]>(),
    finishToolAttempt: vi.fn<RunEventRepository["finishToolAttempt"]>(),
    interruptToolAttempts: vi.fn<RunEventRepository["interruptToolAttempts"]>(),
  } satisfies RunEventRepository;
  const publish = vi.fn<SessionEventPublisher["publish"]>().mockResolvedValue(undefined);
  const id = vi.fn<ResourceIdGenerator>(() => "message-1");
  const now = vi.fn(() => new Date("2026-10-25T00:01:00.000Z"));
  const dependencies = {
    repository,
    publish,
    id,
    now,
    contextSize: 64_000,
    ownershipSignal: ownership.signal,
  };
  const events = new DurableRunEvents(dependencies);
  const started: ModelAttemptStarted = {
    ordinal: 1,
    modelProfileId: "profile-1",
    providerConnectionId: "connection-1",
    model: "model-1",
    purpose: "foreground",
    startedAt: new Date("2026-10-25T00:00:00.000Z"),
  };
  const finished: ModelAttemptFinished = {
    ordinal: 1,
    outcome: "failed",
    reason: "model_http_error",
    status: 429,
    durationMs: 25,
    outputStarted: false,
    usage: {
      inputTokens: 7,
      outputTokens: 2,
      cost: {
        amount: 0.000007,
        currency: "USD",
        source: "estimated",
        pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 },
      },
    },
    finishedAt: new Date("2026-10-25T00:00:00.025Z"),
  };
  return {
    ownership,
    repository,
    publish,
    id,
    now,
    dependencies,
    events,
    started,
    finished,
    receipt,
    invoke: (operation: Operation) =>
      operation === "start" ? events.start("run-1", started) : events.finish("run-1", finished),
  };
}

function observe(pending: Promise<unknown>) {
  const resolved = vi.fn<(value: unknown) => void>();
  const rejected = vi.fn<(error: unknown) => void>();
  return { resolved, rejected, settled: pending.then(resolved, rejected) };
}

describe("durable model attempt events", () => {
  it("preserves a budget denial without retrying or publishing a persistence failure", async () => {
    const f = setup();
    const denied = new ModelBudgetExceededError("organization_daily", "10", "10");
    f.repository.startModelAttempt.mockRejectedValue(denied);
    await expect(f.events.start("run-1", f.started)).rejects.toBe(denied);
    expect(f.repository.startModelAttempt).toHaveBeenCalledOnce();
    expect(f.repository.finishModelAttempt).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("persists the selected candidate context size instead of the original primary size", async () => {
    const f = setup();
    const finished = { ...f.finished, contextSize: 32_000 };
    await f.events.finish("run-1", finished);
    expect(f.repository.finishModelAttempt).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      ...finished,
    });
    expect(f.repository.appendUsage).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.receipt);
  });

  it("keeps start audit private and publishes only usage returned by the atomic finish", async () => {
    const f = setup();
    await f.events.start("run-1", f.started);
    expect(f.repository.startModelAttempt).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      ...f.started,
    });
    expect(f.publish).not.toHaveBeenCalled();
    await f.events.finish("run-1", f.finished);
    expect(f.repository.finishModelAttempt).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      ...f.finished,
      contextSize: 64_000,
    });
    expect(f.repository.appendUsage).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.receipt);
    expect(f.publish.mock.calls[0]![0]).toBe(f.receipt);
    expect(f.id).not.toHaveBeenCalled();
    expect(f.now).not.toHaveBeenCalled();
  });

  it.each(cases)(
    "retries $operation with the original frozen input and publishes only after success",
    async ({ operation, repositoryMethod }) => {
      const f = setup();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const inputs: WriteInput[] = [];
      const snapshots: WriteInput[] = [];
      const write = async (input: WriteInput): Promise<void> => {
        inputs.push(input);
        snapshots.push(structuredClone(input));
        if (inputs.length === 1) {
          entered.resolve();
          await release.promise;
          throw new Error("first original persistence receipt failed");
        }
      };
      if (operation === "start") f.repository.startModelAttempt.mockImplementation(write);
      else
        f.repository.finishModelAttempt.mockImplementation(async (input) => {
          await write(input);
          return f.receipt;
        });
      const expected = structuredClone(
        operation === "start"
          ? { runId: "run-1", ...f.started }
          : { runId: "run-1", ...f.finished, contextSize: 64_000 },
      );
      vi.useFakeTimers({ loopLimit: 20 });
      const result = observe(Promise.resolve().then(() => f.invoke(operation)));
      try {
        await Promise.race([
          entered.promise,
          result.settled.then(() => {
            throw new Error("Original persistence gate was bypassed");
          }),
        ]);
        expect(f.repository[repositoryMethod]).toHaveBeenCalledOnce();
        expect(f.publish).not.toHaveBeenCalled();
        f.started.model = "changed-model";
        f.started.startedAt.setUTCFullYear(2040);
        f.finished.reason = "changed-reason";
        f.finished.finishedAt.setUTCFullYear(2040);
        f.finished.usage.inputTokens = 999;
        if (f.finished.usage.cost?.source === "estimated") {
          f.finished.usage.cost.amount = 99;
          f.finished.usage.cost.pricing.inputPerMillion = 999;
        }
        f.dependencies.contextSize = 128_000;
        expect(inputs[0]).toStrictEqual(expected);
        release.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.repository[repositoryMethod]).toHaveBeenCalledOnce();
        expect(result.resolved).not.toHaveBeenCalled();
        expect(result.rejected).not.toHaveBeenCalled();
        expect(f.publish).not.toHaveBeenCalled();
        await vi.advanceTimersToNextTimerAsync();
        await result.settled;
        expect(f.repository[repositoryMethod]).toHaveBeenCalledTimes(2);
        expect(inputs[1]).toBe(inputs[0]);
        expect(snapshots).toStrictEqual([expected, expected]);
        expect(result.rejected).not.toHaveBeenCalled();
        expect(result.resolved).toHaveBeenCalledExactlyOnceWith(undefined);
        expect(f.publish.mock.calls).toEqual(operation === "start" ? [] : [[f.receipt]]);
        expect(f.repository.appendUsage).not.toHaveBeenCalled();
        expect(f.id).not.toHaveBeenCalled();
        expect(f.now).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release.resolve();
        f.ownership.abort(new WorkerOwnershipLostError());
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

  it.each(cases)(
    "keeps exhausted $operation persistence as RunEventPersistenceError without publishing",
    async ({ operation, repositoryMethod }) => {
      const f = setup();
      const failure = new Error("original model attempt persistence failed");
      f.repository[repositoryMethod].mockRejectedValue(failure);
      vi.useFakeTimers({ loopLimit: 20 });
      const result = observe(Promise.resolve().then(() => f.invoke(operation)));
      try {
        await vi.runAllTimersAsync();
        await result.settled;
        expect(f.repository[repositoryMethod]).toHaveBeenCalledTimes(3);
        expect(result.resolved).not.toHaveBeenCalled();
        expect(result.rejected).toHaveBeenCalledOnce();
        const error = result.rejected.mock.calls[0]![0];
        expect(error).toBeInstanceOf(RunEventPersistenceError);
        if (!(error instanceof RunEventPersistenceError))
          throw new Error("Expected persistence failure");
        expect(error.cause).toBe(failure);
        expect(f.publish).not.toHaveBeenCalled();
        expect(f.repository.appendUsage).not.toHaveBeenCalled();
      } finally {
        f.ownership.abort(new WorkerOwnershipLostError());
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

  it.each(cases)(
    "refuses $operation before dispatch after owner revocation",
    async ({ operation, repositoryMethod }) => {
      const f = setup();
      const lost = new WorkerOwnershipLostError();
      f.ownership.abort(lost);
      await expect(Promise.resolve().then(() => f.invoke(operation))).rejects.toBe(lost);
      expect(f.repository[repositoryMethod]).not.toHaveBeenCalled();
      expect(f.repository.appendUsage).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    "joins the held original $operation after revocation and never publishes late success",
    async ({ operation, repositoryMethod }) => {
      const f = setup();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const write = async (): Promise<void> => {
        entered.resolve();
        await release.promise;
      };
      if (operation === "start") f.repository.startModelAttempt.mockImplementation(write);
      else
        f.repository.finishModelAttempt.mockImplementation(async () => {
          await write();
          return f.receipt;
        });
      const lost = new WorkerOwnershipLostError();
      const result = observe(Promise.resolve().then(() => f.invoke(operation)));
      try {
        await Promise.race([
          entered.promise,
          result.settled.then(() => {
            throw new Error("Original persistence gate was bypassed");
          }),
        ]);
        f.ownership.abort(lost);
        await Promise.resolve();
        expect(result.resolved).not.toHaveBeenCalled();
        expect(result.rejected).not.toHaveBeenCalled();
        expect(f.publish).not.toHaveBeenCalled();
        release.resolve();
        await result.settled;
        expect(result.resolved).not.toHaveBeenCalled();
        expect(result.rejected).toHaveBeenCalledExactlyOnceWith(lost);
        expect(f.repository[repositoryMethod]).toHaveBeenCalledOnce();
        expect(f.repository.appendUsage).not.toHaveBeenCalled();
        expect(f.publish).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        f.ownership.abort(lost);
        await result.settled;
      }
    },
  );
});
