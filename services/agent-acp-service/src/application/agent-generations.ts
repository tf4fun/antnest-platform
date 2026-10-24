import {
  AgentOwnershipLostError,
  leaseDuration,
  ownershipFence,
  ownershipScope,
  type AgentOwnershipFence,
  type AgentOwnershipScope,
} from "../domain/agent-ownership.js";
import type { AgentLease, AgentLeases } from "../ports/agent-leases.js";
import { parseOwnerRegistration, type OwnerRegistration } from "./owner-incarnation.js";

export type AgentGenerationAuthority = Readonly<{
  registration: Readonly<OwnerRegistration>;
  fence: AgentOwnershipFence;
}>;
export type GenerationOptions = {
  registration: OwnerRegistration;
  leases: AgentLeases;
  leaseDurationMs?: number;
  renewIntervalMs?: number;
  operationTimeoutMs?: number;
};
export type GenerationInitializer<T> = (generation: AgentGeneration<T>) => Promise<T>;
export interface AgentGeneration<T> {
  readonly authority: AgentGenerationAuthority;
  readonly signal: AbortSignal;
  readonly taskFailures: readonly unknown[];
  dispatch<R>(operation: (value: T, signal: AbortSignal) => Promise<R>): Promise<R>;
  retainRun(completion: Promise<unknown>): void;
}
type Timing = Readonly<{
  leaseDurationMs: number;
  renewIntervalMs: number;
  operationTimeoutMs: number;
}>;
type Phase = "preparing" | "open" | "draining" | "lost" | "finalizing" | "closed";
const MAX_RETAINED_TASK_FAILURES = 16;

function deadline(lease: AgentLease, startedAt: number, duration: number): number {
  try {
    const remaining = lease.expiresAt.getTime() - lease.observedAt.getTime();
    // Subtract the complete round trip, including pool/lock waits. A delayed
    // successful response never resets the origin to the local receipt time.
    return startedAt + Math.min(duration, remaining);
  } catch {
    return Number.NaN;
  }
}
function sameFence(left: AgentOwnershipFence, right: AgentOwnershipFence): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.agentId === right.agentId &&
    left.ownerInstanceId === right.ownerInstanceId &&
    left.epoch === right.epoch
  );
}

/** Owns one fixed component graph and its original work, not a mutable current owner. */
class ManagedGeneration<T> implements AgentGeneration<T> {
  private readonly cancellation = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly failures: unknown[] = [];
  private readonly boundAuthority: AgentGenerationAuthority;
  private phase: Phase = "preparing";
  private value!: T;
  private expiresAt: number;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private renewal: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  public constructor(
    authority: AgentGenerationAuthority,
    private readonly leases: AgentLeases,
    private readonly timing: Timing,
    expiresAt: number,
    renewAt: number,
    private readonly onLoss: (error: AgentOwnershipLostError) => void,
  ) {
    this.boundAuthority = Object.freeze({
      registration: parseOwnerRegistration(authority.registration),
      fence: ownershipFence(authority.fence),
    });
    this.expiresAt = expiresAt;
    this.armExpiry();
    this.armRenewal(renewAt);
  }
  public get authority(): AgentGenerationAuthority {
    return this.boundAuthority;
  }
  public get signal(): AbortSignal {
    return this.cancellation.signal;
  }
  public get taskFailures(): readonly unknown[] {
    return [...this.failures];
  }

  public async initialize(initialize: GenerationInitializer<T>): Promise<void> {
    this.assertLease();
    this.assertPreparing();
    const expiresAt = performance.now() + this.timing.operationTimeoutMs;
    const budget = setTimeout(() => {
      if (this.phase === "preparing") this.lose(new AgentOwnershipLostError());
    }, this.timing.operationTimeoutMs);
    budget.unref();
    const original = this.track(
      Promise.resolve().then(() => {
        this.assertLease();
        return initialize(this);
      }),
    );
    try {
      // Expiry closes readiness through onLoss without abandoning the original
      // initializer. Retirement and drain continue to join this exact task.
      const value = await original;
      if (this.phase === "preparing" && performance.now() >= expiresAt)
        this.lose(new AgentOwnershipLostError());
      this.assertLease();
      this.assertPreparing();
      this.value = value;
      this.phase = "open";
    } finally {
      clearTimeout(budget);
    }
  }
  public assertDispatch(): void {
    this.assertLease();
    if (this.phase !== "open") throw new AgentOwnershipLostError();
  }
  public dispatch<R>(operation: (value: T, signal: AbortSignal) => Promise<R>): Promise<R> {
    try {
      this.assertDispatch();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new AgentOwnershipLostError());
    }
    // Register before invoking work. Adoption joins the original operation;
    // deliberately never race its completion against cancellation.
    return this.track(
      Promise.resolve()
        .then(() => {
          this.assertLease();
          return operation(this.value, this.signal);
        })
        .then((result) => {
          this.assertLease();
          return result;
        }),
    );
  }
  public retainRun(completion: Promise<unknown>): void {
    if (this.phase === "finalizing" || this.phase === "closed") throw new AgentOwnershipLostError();
    // Already-dispatched admission can receive its completion after loss. It
    // must hand it over before its own tracked operation settles.
    void this.track(completion);
  }
  public lose(error: AgentOwnershipLostError): void {
    if (this.phase === "lost" || this.phase === "closed" || this.phase === "finalizing") return;
    this.phase = "lost";
    this.clearTimers();
    this.cancellation.abort(error);
    this.onLoss(error);
  }
  public beginDrain(): void {
    if (this.phase === "open" || this.phase === "preparing") this.phase = "draining";
  }
  public drain(): Promise<void> {
    this.beginDrain();
    if (this.stopping === undefined) {
      const stopped = Promise.withResolvers<void>();
      this.stopping = stopped.promise;
      void this.finishDrain().then(stopped.resolve, stopped.reject);
    }
    return this.stopping;
  }
  private async finishDrain(): Promise<void> {
    // Admission may hand off an accepted Run while joining. Re-read until that
    // handoff converges. Renewal is deliberately outside the data-task set.
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
    this.phase = "finalizing";
    this.clearTimers();
    this.cancellation.abort(new AgentOwnershipLostError());
    await this.renewal;
    try {
      await this.leases.release(this.authority.fence);
    } finally {
      this.phase = "closed";
    }
  }
  private track<R>(original: Promise<R>): Promise<R> {
    this.tasks.add(original);
    void original.then(
      () => this.tasks.delete(original),
      (error: unknown) => {
        this.rememberFailure(error);
        this.tasks.delete(original);
      },
    );
    return original;
  }
  private assertLease(): void {
    if (this.phase === "lost" || this.phase === "finalizing" || this.phase === "closed")
      throw new AgentOwnershipLostError();
    if (!Number.isFinite(this.expiresAt) || performance.now() >= this.expiresAt) {
      const error = new AgentOwnershipLostError();
      this.lose(error);
      throw error;
    }
  }
  private assertPreparing(): void {
    if (this.phase !== "preparing") throw new AgentOwnershipLostError();
  }
  private armExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => this.lose(new AgentOwnershipLostError()),
      Math.max(0, this.expiresAt - performance.now()),
    );
    this.expiryTimer.unref();
  }
  private armRenewal(at: number): void {
    this.renewTimer = setTimeout(
      () => {
        this.renewal = this.renew();
      },
      Math.max(0, at - performance.now()),
    );
    this.renewTimer.unref();
  }
  private async renew(): Promise<void> {
    const startedAt = performance.now();
    const budget = setTimeout(
      () => this.lose(new AgentOwnershipLostError()),
      this.timing.operationTimeoutMs,
    );
    budget.unref();
    try {
      this.assertLease();
      const receipt = await this.leases.renew(this.authority.fence, this.timing.leaseDurationMs);
      if (this.signal.aborted || this.phase === "finalizing" || this.phase === "closed") return;
      this.assertLease();
      if (performance.now() - startedAt >= this.timing.operationTimeoutMs)
        throw new AgentOwnershipLostError();
      if (receipt === null || !sameFence(ownershipFence(receipt.fence), this.authority.fence))
        throw new AgentOwnershipLostError();
      const next = deadline(receipt, startedAt, this.timing.leaseDurationMs);
      if (!Number.isFinite(next) || next <= performance.now()) throw new AgentOwnershipLostError();
      this.expiresAt = next;
      this.armExpiry();
    } catch (error) {
      this.rememberFailure(error);
      this.lose(new AgentOwnershipLostError());
    } finally {
      clearTimeout(budget);
      if (this.phase === "preparing" || this.phase === "open" || this.phase === "draining")
        this.armRenewal(startedAt + this.timing.renewIntervalMs);
    }
  }
  private clearTimers(): void {
    clearTimeout(this.expiryTimer);
    clearTimeout(this.renewTimer);
  }
  private rememberFailure(error: unknown): void {
    if (this.failures.length === MAX_RETAINED_TASK_FAILURES) this.failures.shift();
    this.failures.push(error);
  }
}

type Slot<T> = {
  scope: AgentOwnershipScope;
  ready: ReturnType<typeof Promise.withResolvers<AgentGeneration<T>>>;
  original: Promise<void>;
  generation?: ManagedGeneration<T>;
  stopping?: Promise<void>;
  closed: boolean;
};
function isClosing<T>(slot: Slot<T>): boolean {
  return slot.closed;
}

export class AgentGenerations<T> {
  private readonly registration: Readonly<OwnerRegistration>;
  private readonly timing: Timing;
  private readonly leases: AgentLeases;
  private readonly slots = new Map<string, Slot<T>>();
  private readonly controls = new Map<string, { cancel(): void; settled: Promise<void> }>();
  private readonly cleanupFailures: unknown[] = [];
  private stopped = false;
  private stopping: Promise<void> | undefined;

  public constructor(options: GenerationOptions) {
    this.registration = parseOwnerRegistration(options.registration);
    this.leases = options.leases;
    const duration = leaseDuration(options.leaseDurationMs ?? 30_000);
    const interval = options.renewIntervalMs ?? 10_000;
    const budget = options.operationTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(interval) ||
      interval < 1 ||
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      interval + budget >= duration
    )
      throw new RangeError("Agent renewal must leave a finite failure margin");
    this.timing = Object.freeze({
      leaseDurationMs: duration,
      renewIntervalMs: interval,
      operationTimeoutMs: budget,
    });
  }
  public prepare(
    input: AgentOwnershipScope,
    initialize: GenerationInitializer<T>,
  ): Promise<AgentGeneration<T>> {
    if (this.stopped) return Promise.reject(new AgentOwnershipLostError());
    const scope = ownershipScope(input);
    const key = JSON.stringify(scope);
    if (this.controls.has(key)) return Promise.reject(new AgentOwnershipLostError());
    const existing = this.slots.get(key);
    if (existing !== undefined)
      return existing.closed
        ? Promise.reject(new AgentOwnershipLostError())
        : existing.ready.promise;
    const slot: Slot<T> = {
      scope,
      ready: Promise.withResolvers<AgentGeneration<T>>(),
      original: Promise.resolve(),
      closed: false,
    };
    void slot.ready.promise.catch(() => {});
    this.slots.set(key, slot);
    slot.original = Promise.resolve()
      .then(async () => {
        if (slot.closed) return;
        const startedAt = performance.now();
        const budget = setTimeout(() => {
          void this.close(slot, new AgentOwnershipLostError());
        }, this.timing.operationTimeoutMs);
        budget.unref();
        let receipt: AgentLease | null;
        try {
          receipt = await this.leases.tryAcquire(
            scope,
            this.registration.incarnation_id,
            this.timing.leaseDurationMs,
          );
        } finally {
          clearTimeout(budget);
        }
        if (receipt === null) throw new AgentOwnershipLostError();
        const fence = ownershipFence(receipt.fence);
        if (
          fence.organizationId !== scope.organizationId ||
          fence.agentId !== scope.agentId ||
          fence.ownerInstanceId !== this.registration.incarnation_id
        )
          throw new AgentOwnershipLostError();
        const authority = Object.freeze({ registration: this.registration, fence });
        const generation = new ManagedGeneration<T>(
          authority,
          this.leases,
          this.timing,
          deadline(receipt, startedAt, this.timing.leaseDurationMs),
          startedAt + this.timing.renewIntervalMs,
          (error) => {
            void this.close(slot, error);
          },
        );
        slot.generation = generation;
        if (performance.now() - startedAt >= this.timing.operationTimeoutMs)
          void this.close(slot, new AgentOwnershipLostError());
        if (isClosing(slot)) {
          generation.lose(new AgentOwnershipLostError());
          return;
        }
        await generation.initialize(initialize);
        if (!isClosing(slot)) slot.ready.resolve(generation);
      })
      .catch((error: unknown) => {
        void this.close(slot, error);
      });
    return slot.ready.promise;
  }

  /** Exclusive lifecycle work; never exposes a user application generation. */
  public runControl<R>(
    input: AgentOwnershipScope,
    operation: (authority: AgentGenerationAuthority, signal: AbortSignal) => Promise<R>,
    signal?: AbortSignal,
    options?: { joinOriginal: boolean },
  ): Promise<R> {
    if (this.stopped || signal?.aborted) return Promise.reject(new AgentOwnershipLostError());
    const scope = ownershipScope(input);
    const key = JSON.stringify(scope);
    if (this.controls.has(key)) return Promise.reject(new AgentOwnershipLostError());
    const result = Promise.withResolvers<R>();
    const finished = Promise.withResolvers<void>();
    const originalFailures: unknown[] = [];
    void result.promise.catch(() => {});
    void finished.promise.catch(() => {});
    const cancellation = new AbortController();
    let generation: ManagedGeneration<R> | undefined;
    const startedAt = performance.now();
    const cancel = () => {
      const error = new AgentOwnershipLostError();
      cancellation.abort(error);
      generation?.lose(error);
      result.reject(error);
    };
    const control = { cancel, settled: finished.promise };
    // Reserve before joining the old slot. Publication and other requests must
    // not acquire another same-scope generation in the retirement window.
    this.controls.set(key, control);
    const budget = setTimeout(cancel, this.timing.operationTimeoutMs);
    budget.unref();
    signal?.addEventListener("abort", cancel, { once: true });
    const assertCurrent = () => {
      cancellation.signal.throwIfAborted();
      if (this.stopped || performance.now() - startedAt >= this.timing.operationTimeoutMs)
        throw new AgentOwnershipLostError();
    };
    void (async () => {
      let value!: R;
      let succeeded = false;
      let cleanupFailure: { error: unknown } | undefined;
      try {
        const previous = this.slots.get(key);
        if (previous !== undefined) {
          try {
            await this.close(previous, new AgentOwnershipLostError());
          } catch (error) {
            // close() already retained this release failure. Keep both scope
            // barriers rather than treating an unknown release as permission.
            cleanupFailure = { error };
            throw error;
          }
        }
        assertCurrent();
        const acquiredAt = performance.now();
        const receipt = await this.leases.tryAcquire(
          scope,
          this.registration.incarnation_id,
          this.timing.leaseDurationMs,
        );
        if (receipt === null) throw new AgentOwnershipLostError();
        const fence = ownershipFence(receipt.fence);
        if (
          fence.organizationId !== scope.organizationId ||
          fence.agentId !== scope.agentId ||
          fence.ownerInstanceId !== this.registration.incarnation_id
        )
          throw new AgentOwnershipLostError();
        generation = new ManagedGeneration<R>(
          Object.freeze({ registration: this.registration, fence }),
          this.leases,
          this.timing,
          deadline(receipt, acquiredAt, this.timing.leaseDurationMs),
          acquiredAt + this.timing.renewIntervalMs,
          cancel,
        );
        // Even a late acquisition belongs to this original operation and must
        // be released. Cancellation can reject the public result before then.
        assertCurrent();
        await generation.initialize(async (captured) => {
          const lifetime = AbortSignal.any([cancellation.signal, captured.signal]);
          lifetime.throwIfAborted();
          value = await operation(captured.authority, lifetime);
          lifetime.throwIfAborted();
          assertCurrent();
          return value;
        });
        succeeded = true;
      } catch (error) {
        // A public timeout is not the end of the original operation. Preserve
        // any independent late failure; the original cancellation reasons are
        // already represented by the rejected public result.
        if (
          cancellation.signal.aborted &&
          cleanupFailure === undefined &&
          !(error instanceof AgentOwnershipLostError) &&
          error !== cancellation.signal.reason &&
          error !== generation?.signal.reason
        ) {
          this.cleanupFailures.push(error);
          originalFailures.push(error);
        }
        result.reject(error);
      } finally {
        try {
          await generation?.drain();
        } catch (error) {
          cleanupFailure = { error };
          this.cleanupFailures.push(error);
          result.reject(error);
        }
        clearTimeout(budget);
        signal?.removeEventListener("abort", cancel);
        if (cleanupFailure !== undefined) finished.reject(cleanupFailure.error);
        else {
          this.controls.delete(key);
          finished.resolve();
          if (succeeded && !cancellation.signal.aborted) {
            try {
              assertCurrent();
              result.resolve(value);
            } catch (error) {
              result.reject(error);
            }
          }
        }
      }
    })();
    if (!options?.joinOriginal) return result.promise;
    return Promise.allSettled([result.promise, finished.promise]).then(([outcome, cleanup]) => {
      const failures = [
        ...new Set([
          ...(outcome.status === "rejected" ? [outcome.reason as unknown] : []),
          ...(cleanup.status === "rejected" ? [cleanup.reason as unknown] : []),
          ...originalFailures,
        ]),
      ];
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "Original Agent control cleanup failed");
      if (outcome.status === "fulfilled") return outcome.value;
      throw outcome.reason;
    });
  }

  public capture(input: AgentOwnershipScope): AgentGeneration<T> {
    const key = JSON.stringify(ownershipScope(input));
    if (this.controls.has(key)) throw new AgentOwnershipLostError();
    const slot = this.slots.get(key);
    if (slot === undefined || slot.closed || slot.generation === undefined)
      throw new AgentOwnershipLostError();
    slot.generation.assertDispatch();
    return slot.generation;
  }
  public closeScope(
    input: AgentOwnershipScope,
    cause: unknown = new AgentOwnershipLostError(),
  ): Promise<void> {
    const key = JSON.stringify(ownershipScope(input));
    const control = this.controls.get(key);
    if (control !== undefined) {
      control.cancel();
      return control.settled;
    }
    const slot = this.slots.get(key);
    return slot === undefined ? Promise.resolve() : this.close(slot, cause);
  }
  public drain(): Promise<void> {
    this.stopped = true;
    for (const control of this.controls.values()) control.cancel();
    this.stopping ??= (async () => {
      await Promise.allSettled([
        ...[...this.slots.values()].map((slot) => this.close(slot, undefined, true)),
        ...[...this.controls.values()].map((control) => control.settled),
      ]);
      if (this.cleanupFailures.length > 0)
        throw new AggregateError(this.cleanupFailures, "Agent generation cleanup failed");
    })();
    return this.stopping;
  }
  private close(slot: Slot<T>, cause: unknown, draining = false): Promise<void> {
    if (slot.stopping !== undefined) return slot.stopping;
    slot.closed = true;
    slot.ready.reject(cause ?? new AgentOwnershipLostError());
    // Publish the retirement barrier before abort callbacks can re-enter close.
    // Keep the scope occupied until the original lease release has settled.
    const done = Promise.withResolvers<void>();
    slot.stopping = done.promise;
    void done.promise.catch(() => {});
    if (draining) slot.generation?.beginDrain();
    else slot.generation?.lose(new AgentOwnershipLostError());
    void (async () => {
      try {
        await slot.original;
        await slot.generation?.drain();
        this.slots.delete(JSON.stringify(slot.scope));
        done.resolve();
      } catch (error) {
        this.cleanupFailures.push(error);
        done.reject(error);
      }
    })();
    return done.promise;
  }
}
