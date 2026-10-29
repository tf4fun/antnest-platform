import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../domain/errors.js";
import { ModelBudgetExceededError, type ModelBudgetSettlement } from "../domain/model-budget.js";
import { normalizeEmbeddedResource } from "../domain/embedded-resource.js";
import type { ModelCandidate, RunExecutionSnapshot } from "../domain/types.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type ModelDelta,
  type PreparedModelCall,
} from "../ports/model.js";
import type { ModelAttemptPort } from "../ports/model-attempts.js";
import type { ProviderCircuitPort } from "../ports/provider-circuit.js";
import { RunEventPersistenceError } from "./durable-run-events.js";
import { ModelRequestLimitError, type ModelRequestBudget } from "./model-request-budget.js";
import { assertModelInputBudget } from "./context-budget.js";
import { createTokenEstimator } from "./token-estimator.js";
import { recordTokenCalibration } from "./token-calibration.js";

export type ModelCallPolicyOptions = {
  providerCircuit?: ProviderCircuitPort;
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

/** The original usage has committed; the response is history, never permission to dispatch. */
export class ModelCallBudgetExceededError extends ModelBudgetExceededError {
  public readonly response: ModelResult | undefined;
  public constructor(
    fact: NonNullable<ModelBudgetSettlement["exceeded"]>,
    response: ModelResult | undefined,
  ) {
    super(fact.scope, fact.limit, fact.used);
    this.name = "ModelCallBudgetExceededError";
    this.response = response === undefined ? undefined : structuredClone(response);
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
    const policy =
      purpose === "compaction"
        ? { max: 0, baseMs: 200, capMs: 30000 }
        : (frozen.snapshot.executionSpec.modelRetry ?? {
            max: 0,
            baseMs: 200,
            capMs: 30000,
          });
    const reserve = purpose === "permission_judge" || purpose === "compaction" ? 1 : 0;
    const candidates = candidateSnapshots(frozen, purpose);
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
      let candidateIndex = 0;
      let retry = 0;
      for (;;) {
        current();
        const snapshot = candidates[candidateIndex]!;
        if (!this.options.budget.canTake(reserve)) throw new ModelRequestLimitError();
        const permit = this.options.providerCircuit?.tryModelAttempt(
          snapshot.organizationId,
          snapshot.providerConnectionId,
          snapshot.executionSpec.model.baseUrl,
        );
        if (this.options.providerCircuit !== undefined && permit === undefined) {
          if (candidateIndex + 1 >= candidates.length)
            throw new ModelError("model_unavailable", "Eligible Provider circuits are open", false);
          candidateIndex += 1;
          retry = 0;
          continue;
        }
        let prepared: PreparedModelCall | undefined;
        try {
          const ordinal = this.options.budget.nextAttempt(reserve);
          const started = clock.monotonic();
          let outputStarted = false;
          const request = immutableCopy({ ...frozen, snapshot });
          const actualRequest: ModelRequest = {
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
          };
          prepared = this.options.model.prepare?.(actualRequest);
          current();
          const estimator = createTokenEstimator(snapshot.executionSpec.model);
          const estimatedInputTokens =
            estimator.estimateMessages(actualRequest.messages) +
            estimator.estimateTools(actualRequest.tools);
          try {
            await this.options.attempts.start(runId, {
              ordinal,
              modelProfileId: snapshot.modelProfileId,
              providerConnectionId: snapshot.providerConnectionId,
              model: snapshot.executionSpec.model.model,
              purpose: purpose ?? "foreground",
              startedAt: new Date(clock.now()),
              estimatedInputTokens,
              tokenizer: snapshot.executionSpec.model.tokenizer ?? "none",
              ...(prepared === undefined
                ? {}
                : { reservation: structuredClone(prepared.reservation) }),
            });
          } catch (error) {
            throw persistenceFailure("model attempt start", error);
          }

          let result: ModelResult | undefined;
          let failure: { error: unknown } | undefined;
          let knownUsage: ModelUsage | undefined;
          let callEntered = false;
          try {
            // The ordinal is already reserved; only recheck time and cancellation
            // after the original start receipt, never consume the slot twice.
            current();
            callEntered = true;
            result = await (prepared === undefined
              ? this.options.model.complete(actualRequest)
              : prepared.complete());
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
          // Do not turn an actual response, output, or reported usage into zero.
          // The original complete task (including its cleanup) has joined here.
          const notDispatched =
            failure !== undefined &&
            result === undefined &&
            !outputStarted &&
            knownUsage === undefined &&
            status === undefined &&
            (!callEntered || prepared?.dispatchState === "not_dispatched");
          let settlement: ModelBudgetSettlement | void;
          try {
            settlement = await this.options.attempts.finish(runId, {
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
              usage: notDispatched
                ? { inputTokens: 0, outputTokens: 0 }
                : structuredClone(knownUsage ?? {}),
              ...(notDispatched ? { notDispatched: true as const } : {}),
              contextSize: snapshot.executionSpec.model.contextWindow,
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

          const circuitOpen =
            permit?.settle(
              signal.aborted || clock.monotonic() >= deadline || cleanupFailed
                ? "neutral"
                : failure === undefined
                  ? "success"
                  : providerHealthFailure(error)
                    ? "failure"
                    : "neutral",
            ) ?? false;

          if (
            settlement?.exceeded !== undefined &&
            !cleanupFailed &&
            (failure === undefined || error instanceof ModelError)
          ) {
            try {
              current();
            } catch (error) {
              throw interrupted(error, result);
            }
            // The original complete/cleanup and durable finish have joined. Do
            // not return a Tool proposal or enter retry/fallback after overspend.
            throw new ModelCallBudgetExceededError(settlement.exceeded, result);
          }

          if (failure === undefined) {
            try {
              current();
            } catch (error) {
              throw interrupted(error, result);
            }
            if (result === undefined) throw new Error("Model attempt completed without a result");
            if (typeof result.usage.inputTokens === "number")
              recordTokenCalibration(snapshot, estimatedInputTokens, result.usage.inputTokens);
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
          if (circuitOpen || retry >= policy.max) {
            if (candidateIndex + 1 >= candidates.length) throw error;
            if (!this.options.budget.canTake(reserve)) throw new ModelRequestLimitError();
            candidateIndex += 1;
            retry = 0;
            continue;
          }
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
          retry += 1;
        } finally {
          // Includes budget/start failures and the original finish receipt. A
          // cancelled or unaccounted probe must not mark a Provider healthy.
          try {
            prepared?.release();
          } finally {
            permit?.settle("neutral");
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function candidateSnapshots(
  input: Pick<ModelRequest, "snapshot" | "messages" | "tools">,
  purpose: ModelRequest["purpose"],
): RunExecutionSnapshot[] {
  const primary = input.snapshot;
  const select = (candidate: ModelCandidate): RunExecutionSnapshot => {
    const model = { ...candidate.model };
    if (purpose === "permission_judge") {
      model.maxOutputTokens = Math.min(256, model.maxOutputTokens);
      model.temperature = 0;
    }
    return {
      ...primary,
      modelProfileId: candidate.modelProfileId,
      providerConnectionId: candidate.providerConnectionId,
      executionSpec: { ...primary.executionSpec, model },
    };
  };
  const snapshots = [
    select({
      modelProfileId: primary.modelProfileId,
      providerConnectionId: primary.providerConnectionId,
      model: primary.executionSpec.model,
    }),
  ];
  if (purpose === "compaction") return snapshots;
  if (primary.executionSpec.modelFailover !== "before_output") return snapshots;
  const needsTools =
    input.tools.length > 0 ||
    input.messages.some(
      (message) =>
        message.role === "tool" ||
        (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0),
    );
  const blocks = input.messages.flatMap((message) => [
    ...message.content,
    ...(message.role === "assistant" ? (message.thought ?? []) : []),
  ]);
  for (const candidate of primary.executionSpec.fallbackModels ?? []) {
    const model = candidate.model;
    if (needsTools && model.supportsTools !== true) continue;
    if (!isDeepStrictEqual(model.thinking, primary.executionSpec.model.thinking)) continue;
    if (
      blocks.some(
        (block) =>
          (block.type === "image" && !model.supportsImages) ||
          (block.type === "audio" && model.supportsAudio !== true) ||
          (block.type === "resource" &&
            "blob" in normalizeEmbeddedResource(block.resource) &&
            model.supportsPdf !== true),
      )
    )
      continue;
    const snapshot = select(candidate);
    try {
      // Preserve the original input. This is the existing context estimate,
      // not the hard token/cost admission bound owned by the budget ledger.
      assertModelInputBudget(snapshot, input.tools, input.messages);
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === "invalid_context_budget" || error.code === "context_budget_exhausted")
      )
        continue;
      throw error;
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}

const defaultClock: Required<NonNullable<ModelCallPolicyOptions["clock"]>> = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  random: () => Math.random(),
};

function persistenceFailure(
  operation: string,
  cause: unknown,
): RunEventPersistenceError | ModelBudgetExceededError {
  return cause instanceof RunEventPersistenceError || cause instanceof ModelBudgetExceededError
    ? cause
    : new RunEventPersistenceError(operation, cause);
}

function providerHealthFailure(error: unknown): boolean {
  if (
    !(error instanceof ModelError) ||
    error instanceof ModelTransportCleanupError ||
    !error.retryable
  )
    return false;
  if (error.code === "model_http_error")
    return (
      error.status === 408 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500 && error.status <= 599)
    );
  return (
    error.status === undefined &&
    (error.code === "model_unavailable" || error.code === "provider_endpoint_unavailable")
  );
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
