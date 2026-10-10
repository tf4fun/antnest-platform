import { DomainError } from "../domain/errors.js";

type AgentScope = { organizationId: string; agentId: string };
export class ForegroundLearningPreempted extends Error {
  public constructor() {
    super("Foreground Run preempted Skill learning maintenance");
  }
}
export class LifecycleLearningStopped extends Error {
  public constructor() {
    super("Agent lifecycle stopped Skill learning maintenance");
  }
}
type Slot = {
  scope: AgentScope;
  kind: "read" | "learning" | "cleanup";
  /** Learning never holds foreground or lifecycle; bounded reads and cleanup do. */
  yields: boolean;
  controller: AbortController;
  signal: AbortSignal;
  finished: PromiseWithResolvers<void>;
};
type Lease = { signal: AbortSignal; finish(): void };
type PendingSourceReads = { scope: AgentScope; tickets: Set<AbortController> };
const SOURCE_READ_WAIT_MS = 2_000;

/** Keeps one background Runtime user per Agent; only non-learning users are awaited. */
export class LearningForegroundGate {
  private readonly active = new Map<string, Slot>();
  private readonly allowedByOrganization = new Map<string, Set<string>>();
  private readonly pendingSourceReads = new Map<string, PendingSourceReads>();

  public constructor(
    private readonly foregroundActive: (scope: AgentScope) => boolean,
    private readonly waitMs = 10_000,
  ) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 60_000)
      throw new Error("Invalid learning foreground wait limit");
  }

  /** Learning work; foreground admission and lifecycle abort it without waiting. */
  public beginLearning(scope: AgentScope, parent: AbortSignal): Lease {
    return this.open(scope, parent, { kind: "learning", yields: true, requireAllowed: true });
  }

  /** A bounded Runtime read that finishes before a foreground Run is admitted. */
  public begin(scope: AgentScope, parent: AbortSignal): Lease {
    return this.open(scope, parent, { kind: "read", yields: false, requireAllowed: true });
  }

  /** Source reads may briefly wait for another read, never for write or foreground work. */
  public async beginSourceRead(scope: AgentScope, parent: AbortSignal): Promise<Lease> {
    parent.throwIfAborted();
    const key = agentKey(scope);
    const ticket = new AbortController();
    const signal = AbortSignal.any([parent, ticket.signal]);
    const pending = this.pendingSourceReads.get(key) ?? {
      scope,
      tickets: new Set<AbortController>(),
    };
    pending.tickets.add(ticket);
    this.pendingSourceReads.set(key, pending);
    const deadline = Date.now() + SOURCE_READ_WAIT_MS;
    try {
      for (;;) {
        parent.throwIfAborted();
        ticket.signal.throwIfAborted();
        const allowed = this.allowedByOrganization.get(scope.organizationId);
        if (this.foregroundActive(scope) || (allowed !== undefined && !allowed.has(scope.agentId)))
          throw new Error("Source read cannot start while Agent is busy");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Source read admission timed out");
        const slot = this.active.get(key);
        if (slot === undefined) return this.begin(scope, parent);
        if (slot.kind !== "read") throw new Error("Source read cannot start while Agent is busy");
        slot.signal.throwIfAborted();
        const finished = await waitForQuiescence(
          slot.finished.promise,
          AbortSignal.any([signal, slot.signal]),
          remaining,
        );
        parent.throwIfAborted();
        ticket.signal.throwIfAborted();
        slot.signal.throwIfAborted();
        if (!finished) throw new Error("Source read admission timed out");
      }
    } finally {
      // Keep the ticket through synchronous admission: preemption in the
      // preceding read's finish-to-wakeup gap must still cancel this request.
      pending.tickets.delete(ticket);
      if (pending.tickets.size === 0 && this.pendingSourceReads.get(key) === pending)
        this.pendingSourceReads.delete(key);
    }
  }

  /** Temporary cleanup has its own durable fence and may examine a closed Agent. */
  public beginTemporaryCleanup(scope: AgentScope, parent: AbortSignal): Lease {
    return this.open(scope, parent, { kind: "cleanup", yields: false, requireAllowed: false });
  }

  private open(
    scope: AgentScope,
    parent: AbortSignal,
    mode: { kind: Slot["kind"]; yields: boolean; requireAllowed: boolean },
  ): Lease {
    parent.throwIfAborted();
    const key = agentKey(scope);
    const allowed = this.allowedByOrganization.get(scope.organizationId);
    if (
      this.foregroundActive(scope) ||
      this.active.has(key) ||
      (mode.requireAllowed && allowed !== undefined && !allowed.has(scope.agentId))
    )
      throw new Error("Learning maintenance cannot start while Agent is busy");
    const controller = new AbortController();
    const slot: Slot = {
      scope,
      kind: mode.kind,
      yields: mode.yields,
      controller,
      signal: AbortSignal.any([parent, controller.signal]),
      finished: Promise.withResolvers<void>(),
    };
    this.active.set(key, slot);
    let finished = false;
    return {
      signal: slot.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        if (this.active.get(key) === slot) this.active.delete(key);
        slot.finished.resolve();
      },
    };
  }

  public async preempt(scope: AgentScope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.cancelSourceReads(scope, new ForegroundLearningPreempted());
    const slot = this.active.get(agentKey(scope));
    if (!slot) return;
    slot.controller.abort(new ForegroundLearningPreempted());
    if (slot.yields) return;
    if (await waitForQuiescence(slot.finished.promise, signal, this.waitMs)) return;
    signal.throwIfAborted();
    throw barrier();
  }

  public syncOrganization(
    organizationId: string,
    agents: readonly { agent_id: string; accepting_runs: boolean }[],
  ): void {
    const allowed = new Set(
      agents.filter((agent) => agent.accepting_runs).map((agent) => agent.agent_id),
    );
    this.allowedByOrganization.set(organizationId, allowed);
    for (const pending of this.pendingSourceReads.values())
      if (pending.scope.organizationId === organizationId && !allowed.has(pending.scope.agentId))
        this.cancelSourceReads(pending.scope, new LifecycleLearningStopped());
    for (const slot of this.active.values())
      if (slot.scope.organizationId === organizationId && !allowed.has(slot.scope.agentId))
        slot.controller.abort(new LifecycleLearningStopped());
  }

  public canResume(scope: AgentScope): boolean {
    return this.allowedByOrganization.get(scope.organizationId)?.has(scope.agentId) === true;
  }

  public async closeForLifecycle(scope: AgentScope, signal: AbortSignal): Promise<boolean> {
    const allowed = this.allowedByOrganization.get(scope.organizationId) ?? new Set<string>();
    allowed.delete(scope.agentId);
    this.allowedByOrganization.set(scope.organizationId, allowed);
    this.cancelSourceReads(scope, new LifecycleLearningStopped());
    const slot = this.active.get(agentKey(scope));
    if (slot === undefined) return true;
    slot.controller.abort(new LifecycleLearningStopped());
    if (slot.yields) return true;
    return waitForQuiescence(slot.finished.promise, signal, this.waitMs);
  }

  private cancelSourceReads(scope: AgentScope, reason: Error): void {
    for (const ticket of this.pendingSourceReads.get(agentKey(scope))?.tickets ?? [])
      ticket.abort(reason);
  }
}

function waitForQuiescence(
  finished: Promise<void>,
  signal: AbortSignal,
  waitMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, waitMs);
    const aborted = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    void finished.then(() => {
      cleanup();
      resolve(true);
    });
  });
}

function barrier(): DomainError {
  return new DomainError(
    "runtime_barrier_required",
    "A background Runtime read is still running; retry shortly",
  );
}

function agentKey(scope: AgentScope): string {
  return JSON.stringify([scope.organizationId, scope.agentId]);
}
