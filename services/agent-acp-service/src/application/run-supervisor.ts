import type { AcceptedAcpRun, SubmittedAcpRun } from "../ports/acp-application.js";
import type { ConnectionBinding } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";
import { createShutdownReason } from "../shutdown.js";
import {
  isExecutionAccessRevoked,
  type ExecutionAccessSnapshot,
  type ExecutionIdentity,
} from "../domain/execution-configuration.js";
import type { RunExecutionPort } from "./run-executor.js";
import { InvalidationListeners } from "./invalidation-listeners.js";

type RunSlot = {
  binding: ConnectionBinding;
  sessionId: string;
  runId: string | null;
  pendingTargetCancels: Set<string>;
  controller: AbortController;
  accessDenied: DomainError | null;
  finished: PromiseWithResolvers<void>;
  waiters: Set<() => void>;
};

type AgentScope = Pick<ConnectionBinding, "organizationId" | "agentId">;

class LifecycleCancellation extends Error {
  public constructor() {
    super("Agent lifecycle requested execution cancellation");
  }
}

export type RunSubmission = {
  binding: ConnectionBinding;
  sessionId: string;
  outputChanged: () => void;
};

export interface RunLifecyclePort {
  submit(
    input: RunSubmission,
    accept: (signal: AbortSignal) => Promise<AcceptedAcpRun>,
  ): Promise<SubmittedAcpRun>;
  cancel(sessionId: string): Promise<void>;
  cancelTarget(sessionId: string, runId: string): Promise<void>;
}

export class RunSupervisor implements RunLifecyclePort {
  private readonly stopping = new AbortController();
  private readonly active = new Map<string, RunSlot>();
  private readonly changes = new InvalidationListeners();

  public constructor(
    private readonly delegate: RunExecutionPort,
    private readonly beforeAccept: (
      binding: ConnectionBinding,
      signal: AbortSignal,
    ) => Promise<void> = () => Promise.resolve(),
  ) {}

  public get stopSignal(): AbortSignal {
    return this.stopping.signal;
  }

  public occupancy(identity: ExecutionIdentity): { busy: boolean; activeSessionId: string | null } {
    const slot = this.active.get(agentKey(identity));
    return {
      busy: slot !== undefined,
      activeSessionId: slot?.binding.principalId === identity.principalId ? slot.sessionId : null,
    };
  }

  public subscribe(scope: AgentScope, changed: () => void): () => void {
    return this.changes.subscribe(agentKey(scope), changed);
  }

  public async submit(
    input: RunSubmission,
    accept: (signal: AbortSignal) => Promise<AcceptedAcpRun>,
  ): Promise<SubmittedAcpRun> {
    if (this.stopping.signal.aborted) {
      throw new DomainError("service_stopping", "Agent ACP Service is not accepting new Runs");
    }
    const key = agentKey(input.binding);
    if (this.active.has(key)) {
      throw new DomainError("agent_busy", "Agent already has an active Run");
    }
    const slot: RunSlot = {
      binding: { ...input.binding },
      sessionId: input.sessionId,
      runId: null,
      pendingTargetCancels: new Set(),
      controller: new AbortController(),
      accessDenied: null,
      finished: Promise.withResolvers<void>(),
      waiters: new Set(),
    };
    this.active.set(key, slot);
    this.changes.invalidate(key);
    try {
      try {
        await this.beforeAccept(input.binding, slot.controller.signal);
        // A completed cleanup can resume after publication without having
        // thrown the abort. Do not start durable acceptance for that lifetime.
        if (
          slot.accessDenied !== null &&
          (slot.controller.signal.reason === slot.accessDenied ||
            slot.controller.signal.reason instanceof LifecycleCancellation)
        )
          slot.controller.signal.throwIfAborted();
      } catch (error) {
        // Publication can revoke a preparing request after lifecycle cancellation
        // has already fixed the signal's first reason. Preserve that signal and
        // join, but report the retained authorization denial for this lifetime.
        if (
          error instanceof LifecycleCancellation &&
          error === slot.controller.signal.reason &&
          slot.accessDenied !== null
        )
          throw Object.assign(slot.accessDenied, { cause: error });
        throw error;
      }
      const accepted = await accept(slot.controller.signal);
      slot.runId = accepted.runId;
      if (slot.pendingTargetCancels.has(accepted.runId))
        slot.controller.abort(new Error("Target ACP Run cancelled"));
      slot.pendingTargetCancels.clear();
      const completion = Promise.resolve().then(() =>
        this.delegate.execute({
          accepted,
          signal: slot.controller.signal,
          publish: () => {
            notify(input.outputChanged);
            return Promise.resolve();
          },
        }),
      );
      const finish = () => {
        this.remove(key, slot);
        notify(input.outputChanged);
      };
      // Observe failures even if the protocol connection disappears. The
      // original promise still carries the real result to surviving callers.
      void completion.then(finish, finish);
      return { ...accepted, completion };
    } catch (error) {
      this.remove(key, slot);
      throw error;
    }
  }

  public async cancel(sessionId: string): Promise<void> {
    const slots = [...this.active.values()].filter((slot) => slot.sessionId === sessionId);
    for (const slot of slots) slot.controller.abort(new Error("ACP Session cancelled"));
    await Promise.all(slots.map((slot) => slot.finished.promise));
  }

  public async cancelTarget(sessionId: string, runId: string): Promise<void> {
    const slots = [...this.active.values()].filter((slot) => slot.sessionId === sessionId);
    const matched: RunSlot[] = [];
    for (const slot of slots) {
      if (slot.runId === null) {
        slot.pendingTargetCancels.add(runId);
      } else if (slot.runId === runId) {
        slot.controller.abort(new Error("Target ACP Run cancelled"));
        matched.push(slot);
      }
    }
    await Promise.all(matched.map((slot) => slot.finished.promise));
  }

  // Only local dispatch quiescence. Remote stopping evidence is a separate fact.
  public quiesceAgent(
    scope: AgentScope,
    mode: "wait" | "cancel",
    stopWaiting: AbortSignal,
  ): Promise<boolean> {
    if (stopWaiting.aborted) return Promise.resolve(false);
    const slot = this.active.get(agentKey(scope));
    if (slot === undefined) return Promise.resolve(true);
    if (mode === "cancel") slot.controller.abort(new LifecycleCancellation());
    return waitForSlot(slot, stopWaiting);
  }

  public revokeAccess(snapshot: ExecutionAccessSnapshot): Promise<void> {
    const revoked: RunSlot[] = [];
    for (const slot of this.active.values()) {
      if (isExecutionAccessRevoked(snapshot, slot.binding)) {
        revoked.push(slot);
        slot.accessDenied ??= new DomainError("access_denied", "Agent access was revoked");
        slot.controller.abort(slot.accessDenied);
      }
    }
    return Promise.all(revoked.map((slot) => slot.finished.promise)).then(() => undefined);
  }

  public stop(reason: Error): void {
    this.stopping.abort(reason);
    for (const slot of this.active.values()) slot.controller.abort(reason);
  }

  public async shutdown(): Promise<void> {
    if (!this.stopping.signal.aborted) this.stop(createShutdownReason());
    await Promise.all([...this.active.values()].map((slot) => slot.finished.promise));
  }

  private remove(key: string, slot: RunSlot): void {
    if (this.active.get(key) === slot) this.active.delete(key);
    slot.finished.resolve();
    for (const finish of slot.waiters) finish();
    this.changes.invalidate(key);
  }
}

function agentKey(scope: AgentScope): string {
  return JSON.stringify([scope.organizationId, scope.agentId]);
}

function waitForSlot(slot: RunSlot, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (quiescent: boolean) => {
      slot.waiters.delete(onFinished);
      signal.removeEventListener("abort", onAbort);
      resolve(quiescent);
    };
    const onFinished = () => finish(true);
    const onAbort = () => finish(false);
    slot.waiters.add(onFinished);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function notify(outputChanged: () => void): void {
  try {
    outputChanged();
  } catch {
    // Delivery is a hint; reconnect reads persisted output and terminal state.
  }
}
