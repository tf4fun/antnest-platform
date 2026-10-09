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
  /** Learning never holds foreground or lifecycle; bounded reads and cleanup do. */
  yields: boolean;
  controller: AbortController;
  finished: PromiseWithResolvers<void>;
};
type Lease = { signal: AbortSignal; finish(): void };

/** Keeps one background Runtime user per Agent; only non-learning users are awaited. */
export class LearningForegroundGate {
  private readonly active = new Map<string, Slot>();
  private readonly allowedByOrganization = new Map<string, Set<string>>();

  public constructor(
    private readonly foregroundActive: (scope: AgentScope) => boolean,
    private readonly waitMs = 10_000,
  ) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 60_000)
      throw new Error("Invalid learning foreground wait limit");
  }

  /** Learning work; foreground admission and lifecycle abort it without waiting. */
  public beginLearning(scope: AgentScope, parent: AbortSignal): Lease {
    return this.open(scope, parent, { yields: true, requireAllowed: true });
  }

  /** A bounded Runtime read that finishes before a foreground Run is admitted. */
  public begin(scope: AgentScope, parent: AbortSignal): Lease {
    return this.open(scope, parent, { yields: false, requireAllowed: true });
  }

  /** Temporary cleanup has its own durable fence and may examine a closed Agent. */
  public beginTemporaryCleanup(scope: AgentScope, parent: AbortSignal): Lease {
    return this.open(scope, parent, { yields: false, requireAllowed: false });
  }

  private open(
    scope: AgentScope,
    parent: AbortSignal,
    mode: { yields: boolean; requireAllowed: boolean },
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
    const slot: Slot = {
      scope,
      yields: mode.yields,
      controller: new AbortController(),
      finished: Promise.withResolvers<void>(),
    };
    this.active.set(key, slot);
    let finished = false;
    return {
      signal: AbortSignal.any([parent, slot.controller.signal]),
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
    const slot = this.active.get(agentKey(scope));
    if (slot === undefined) return true;
    slot.controller.abort(new LifecycleLearningStopped());
    if (slot.yields) return true;
    return waitForQuiescence(slot.finished.promise, signal, this.waitMs);
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
