import { setTimeout as delay } from "node:timers/promises";
import {
  ModelError,
  ModelTransportCleanupError,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type ModelDelta,
} from "../ports/model.js";
import type { ModelAttemptPort } from "../ports/model-attempts.js";
import { RunEventPersistenceError } from "./durable-run-events.js";
import { ModelRequestLimitError, type ModelRequestBudget } from "./model-request-budget.js";

export type ModelCallPolicyOptions = {
  model: ModelPort;
  budget: ModelRequestBudget;
  attempts: ModelAttemptPort;
  clock?: Partial<{
    now: () => number;
    monotonic: () => number;
    wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
    random: () => number;
  }>;
};

export class ModelCallInterruptedError extends ModelError {
  public constructor(
    cause: unknown,
    public readonly response: ModelResult | undefined,
    public readonly deadlineExceeded: boolean,
  ) {
    super(
      "model_unavailable",
      deadlineExceeded ? "Model call deadline exceeded" : "Model call interrupted",
      false,
      undefined,
      { cause },
    );
    this.name = "ModelCallInterruptedError";
    if (response !== undefined) {
      this.response = structuredClone(response);
      this.usage = structuredClone(response.usage);
      this.outputStarted = hasOutput(response);
    }
  }
}

export class ModelCallPolicy {
  public constructor(private readonly options: ModelCallPolicyOptions) {}

  public async complete(input: { runId: string; request: ModelRequest }): Promise<ModelResult> {
    const clock = { ...defaultClock, ...this.options.clock };
    const runId = input.runId;
    const originalSignal = input.request.signal;
    const onDelta = input.request.onDelta;
    const purpose = input.request.purpose;
    const enteredAt = clock.monotonic();
    const remaining = input.request.snapshot.deadlineAt.getTime() - clock.now();
    const deadline =
      enteredAt + Math.min(remaining, purpose === "permission_judge" ? 10000 : Infinity);
    const frozen = immutableCopy({
      snapshot: input.request.snapshot,
      messages: input.request.messages,
      tools: input.request.tools,
    });
    const policy = frozen.snapshot.executionSpec.modelRetry ?? {
      max: 0,
      baseMs: 200,
      capMs: 30000,
    };
    const reserve = purpose === "permission_judge" ? 1 : 0;
    const timeout = new AbortController();
    const signal = AbortSignal.any([originalSignal, timeout.signal]);
    const expired = new ModelCallInterruptedError(undefined, undefined, true);
    const interrupted = (error: unknown, response: ModelResult | undefined): unknown =>
      response === undefined || error instanceof RunEventPersistenceError
        ? error
        : new ModelCallInterruptedError(
            error,
            response,
            timeout.signal.aborted || clock.monotonic() >= deadline,
          );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = (): void => {
      signal.throwIfAborted();
      if (!Number.isFinite(deadline) || clock.monotonic() >= deadline) {
        timeout.abort(expired);
        throw expired;
      }
    };
    const armDeadline = (): void => {
      const left = deadline - clock.monotonic();
      if (left <= 0) timeout.abort(expired);
      else {
        timer = setTimeout(armDeadline, Math.min(Math.ceil(left), 2_147_483_647));
        timer.unref();
      }
    };
    current();
    armDeadline();
    try {
      for (let retry = 0; ; retry += 1) {
        current();
        const ordinal = this.options.budget.nextAttempt(reserve);
        const started = clock.monotonic();
        try {
          await this.options.attempts.start(runId, {
            ordinal,
            modelProfileId: frozen.snapshot.modelProfileId,
            providerConnectionId: frozen.snapshot.providerConnectionId,
            model: frozen.snapshot.executionSpec.model.model,
            purpose: purpose ?? "foreground",
            startedAt: new Date(clock.now()),
          });
        } catch (error) {
          throw persistenceFailure("model attempt start", error);
        }

        let result: ModelResult | undefined;
        let failure: { error: unknown } | undefined;
        let knownUsage: ModelUsage | undefined;
        let outputStarted = false;
        try {
          // The ordinal is already reserved; only recheck time and cancellation
          // after the original start receipt, never consume the slot twice.
          current();
          const request = immutableCopy(frozen);
          current();
          result = await this.options.model.complete({
            ...request,
            ...(purpose === undefined ? {} : { purpose }),
            signal,
            ...(onDelta === undefined
              ? {}
              : {
                  onDelta: async (delta: ModelDelta) => {
                    outputStarted ||= delta.text.length > 0;
                    signal.throwIfAborted();
                    await onDelta(delta);
                  },
                }),
          });
          knownUsage = result.usage;
          outputStarted ||= hasOutput(result);
          current();
        } catch (originalError) {
          const error = interrupted(originalError, result);
          failure = { error };
          if (error instanceof ModelError) {
            knownUsage = error.usage ?? knownUsage;
            outputStarted ||= error.outputStarted;
            error.outputStarted = outputStarted;
          }
        }

        const cancelled = signal.aborted || clock.monotonic() >= deadline;
        const cleanupFailed = failure?.error instanceof ModelTransportCleanupError;
        const error = failure?.error;
        const status = error instanceof ModelError ? error.status : undefined;
        try {
          await this.options.attempts.finish(runId, {
            ordinal,
            outcome: cleanupFailed
              ? "failed"
              : cancelled
                ? "cancelled"
                : failure === undefined
                  ? "completed"
                  : "failed",
            reason: cleanupFailed
              ? "model_cleanup_failed"
              : cancelled
                ? timeout.signal.aborted || clock.monotonic() >= deadline
                  ? "deadline_exceeded"
                  : "cancelled"
                : failure === undefined
                  ? "completed"
                  : failureReason(error),
            durationMs: Math.max(0, clock.monotonic() - started),
            outputStarted,
            usage: structuredClone(knownUsage ?? {}),
            ...(status === undefined ? {} : { status }),
            finishedAt: new Date(clock.now()),
          });
        } catch (accountingError) {
          const accounting = persistenceFailure("model attempt finish", accountingError);
          if (error instanceof ModelTransportCleanupError) {
            throw new ModelTransportCleanupError(
              new AggregateError(
                [error, accounting],
                "Model cleanup and attempt persistence failed",
              ),
              knownUsage,
              outputStarted,
            );
          }
          if (failure !== undefined)
            throw new RunEventPersistenceError(
              "model attempt finish",
              new AggregateError([error, accounting], "Model attempt and persistence failed"),
            );
          throw accounting;
        }

        if (failure === undefined) {
          try {
            current();
          } catch (error) {
            throw interrupted(error, result);
          }
          if (result === undefined) throw new Error("Model attempt completed without a result");
          return result;
        }
        if (
          !(error instanceof ModelError) ||
          error instanceof ModelTransportCleanupError ||
          !error.retryable ||
          outputStarted ||
          error.status === 400 ||
          error.status === 401
        )
          throw error;
        current();
        if (retry >= policy.max) throw error;
        if (!this.options.budget.canTake(reserve)) throw new ModelRequestLimitError();

        const random = clock.random();
        const fraction = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0;
        const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** retry);
        const retryAfter = Number.isNaN(error.retryAfterMs)
          ? 0
          : Math.max(0, error.retryAfterMs ?? 0);
        const milliseconds = Math.min(policy.capMs, Math.max(ceiling * fraction, retryAfter));
        const wakeAt = Math.min(deadline, clock.monotonic() + milliseconds);
        for (;;) {
          current();
          const left = wakeAt - clock.monotonic();
          if (left <= 0) break;
          await clock.wait(left, signal);
        }
        current();
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

const defaultClock: Required<NonNullable<ModelCallPolicyOptions["clock"]>> = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  random: () => Math.random(),
};

function persistenceFailure(operation: string, cause: unknown): RunEventPersistenceError {
  return cause instanceof RunEventPersistenceError
    ? cause
    : new RunEventPersistenceError(operation, cause);
}

function failureReason(error: unknown): string {
  if (error instanceof ModelTransportCleanupError) return "model_cleanup_failed";
  if (error instanceof RunEventPersistenceError) return "persistence_failed";
  return error instanceof ModelError ? error.code : "unknown_error";
}

function hasOutput(result: ModelResult): boolean {
  const nonempty = (blocks: ModelResult["content"]): boolean =>
    blocks.some(
      (block) => block.type !== "text" || (typeof block.text === "string" && block.text.length > 0),
    );
  return (
    nonempty(result.content) ||
    nonempty(result.thought ?? []) ||
    (result.kind === "tool_calls" && result.calls.length > 0)
  );
}

function immutableCopy<T>(value: T): T {
  const copied = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(copied);
  return copied;
}
