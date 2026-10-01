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
type MaintenanceSlot = {
  scope: AgentScope;
  executionId: string | null;
  controller: AbortController;
  finished: PromiseWithResolvers<boolean>;
};

/** Coordinates local maintenance with foreground admission; unknown remote effects stay fenced. */
export class LearningForegroundGate {
  private readonly active = new Map<string, MaintenanceSlot>();
  private readonly unsafe = new Map<string, string | null>();
  private readonly currentExecution = new Map<string, Map<string, string | null>>();
  private readonly allowedByOrganization = new Map<string, Set<string>>();

  public constructor(
    private readonly foregroundActive: (scope: AgentScope) => boolean,
    private readonly waitMs = 10_000,
  ) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 60_000)
      throw new Error("Invalid learning foreground wait limit");
  }

  public begin(
    scope: AgentScope,
    parent: AbortSignal,
  ): { signal: AbortSignal; finish(quiescent: boolean): void } {
    return this.open(scope, parent, "maintenance");
  }

  /** Permits observation of an already unsafe Agent while still excluding foreground work. */
  public beginRecovery(
    scope: AgentScope,
    parent: AbortSignal,
  ): { signal: AbortSignal; finish(quiescent: boolean): void } {
    return this.open(scope, parent, "recovery");
  }

  /** Temporary cleanup has its own durable fence; it cannot resolve learning's unknown effects. */
  public beginTemporaryCleanup(
    scope: AgentScope,
    parent: AbortSignal,
  ): { signal: AbortSignal; finish(): void } {
    const lease = this.open(scope, parent, "temporary");
    return { signal: lease.signal, finish: () => lease.finish(true) };
  }

  private open(
    scope: AgentScope,
    parent: AbortSignal,
    mode: "maintenance" | "recovery" | "temporary",
  ): { signal: AbortSignal; finish(quiescent: boolean): void } {
    parent.throwIfAborted();
    const key = agentKey(scope);
    const allowed = this.allowedByOrganization.get(scope.organizationId);
    if (
      this.foregroundActive(scope) ||
      this.active.has(key) ||
      (mode === "maintenance" &&
        (this.unsafe.has(key) || (allowed !== undefined && !allowed.has(scope.agentId))))
    )
      throw new Error("Learning maintenance cannot start while Agent is busy or unsettled");
    const slot: MaintenanceSlot = {
      scope,
      executionId: this.currentExecution.get(scope.organizationId)?.get(scope.agentId) ?? null,
      controller: new AbortController(),
      finished: Promise.withResolvers<boolean>(),
    };
    this.active.set(key, slot);
    let finished = false;
    return {
      signal: AbortSignal.any([parent, slot.controller.signal]),
      finish: (quiescent) => {
        if (finished) return;
        finished = true;
        if (mode !== "temporary" && !quiescent) {
          // A closed Agent may have no current binding while recovery examines
          // an old unknown effect. Keep its original execution identity.
          if (!(mode === "recovery" && slot.executionId === null && this.unsafe.has(key)))
            this.unsafe.set(key, slot.executionId);
        } else if (mode === "recovery" && this.unsafe.get(key) === slot.executionId)
          this.unsafe.delete(key);
        if (this.active.get(key) === slot) this.active.delete(key);
        slot.finished.resolve(quiescent);
      },
    };
  }

  public async preempt(scope: AgentScope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const key = agentKey(scope);
    if (this.unsafe.has(key)) throw barrier();
    const slot = this.active.get(key);
    if (!slot) return;
    slot.controller.abort(new ForegroundLearningPreempted());
    const settled = await waitForQuiescence(slot.finished.promise, signal, this.waitMs);
    if (!settled || this.unsafe.has(key)) throw barrier();
  }

  public syncOrganization(
    organizationId: string,
    agents: readonly {
      agent_id: string;
      accepting_runs: boolean;
      runtime?: { runtime_execution_id: string } | null;
    }[],
  ): void {
    const allowed = new Set(
      agents.filter((agent) => agent.accepting_runs).map((agent) => agent.agent_id),
    );
    this.allowedByOrganization.set(organizationId, allowed);
    const currentExecution = new Map<string, string | null>();
    for (const agent of agents) {
      const key = agentKey({ organizationId, agentId: agent.agent_id });
      const executionId =
        agent.accepting_runs && agent.runtime?.runtime_execution_id
          ? agent.runtime.runtime_execution_id
          : null;
      currentExecution.set(agent.agent_id, executionId);
      const unsafeExecution = this.unsafe.get(key);
      if (
        executionId !== null &&
        unsafeExecution !== undefined &&
        unsafeExecution !== null &&
        unsafeExecution !== executionId
      )
        this.unsafe.delete(key);
    }
    this.currentExecution.set(organizationId, currentExecution);
    for (const slot of this.active.values())
      if (slot.scope.organizationId === organizationId && !allowed.has(slot.scope.agentId))
        slot.controller.abort(new LifecycleLearningStopped());
  }

  /** Recovery may observe a closed Agent, but must not resume its candidate. */
  public canResume(scope: AgentScope): boolean {
    return (
      this.allowedByOrganization.get(scope.organizationId)?.has(scope.agentId) === true &&
      !this.unsafe.has(agentKey(scope))
    );
  }

  /** Old effects cannot hold the execution slot of a newly published Runtime. */
  public requiresBarrier(scope: AgentScope, effectExecutionId: string | undefined): boolean {
    const current = this.currentExecution.get(scope.organizationId)?.get(scope.agentId);
    if (
      current === null ||
      current === undefined ||
      effectExecutionId === undefined ||
      !this.allowedByOrganization.get(scope.organizationId)?.has(scope.agentId)
    )
      return true;
    return effectExecutionId === current;
  }

  public async closeForLifecycle(scope: AgentScope, signal: AbortSignal): Promise<boolean> {
    const allowed = this.allowedByOrganization.get(scope.organizationId) ?? new Set<string>();
    allowed.delete(scope.agentId);
    this.allowedByOrganization.set(scope.organizationId, allowed);
    const key = agentKey(scope);
    const slot = this.active.get(key);
    if (slot === undefined) return !this.unsafe.has(key);
    slot.controller.abort(new LifecycleLearningStopped());
    try {
      const settled = await waitForQuiescence(slot.finished.promise, signal, this.waitMs);
      return settled && !this.unsafe.has(key);
    } catch {
      return false;
    }
  }

  /** Called only after the durable Runtime observation has resolved the unknown effect. */
  public resolveUnknown(scope: AgentScope): void {
    const key = agentKey(scope);
    if (this.active.has(key))
      throw new Error("Cannot clear an active learning maintenance barrier");
    this.unsafe.delete(key);
  }
}

function waitForQuiescence(
  finished: Promise<boolean>,
  signal: AbortSignal,
  waitMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(barrier());
    }, waitMs);
    const aborted = () => {
      cleanup();
      reject(asError(signal.reason));
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
    void finished.then(
      (safe) => {
        cleanup();
        resolve(safe);
      },
      (error: unknown) => {
        cleanup();
        reject(asError(error));
      },
    );
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function barrier(): DomainError {
  return new DomainError(
    "runtime_barrier_required",
    "Skill maintenance may still be using the Runtime; retry after effect recovery",
  );
}

function agentKey(scope: AgentScope): string {
  return JSON.stringify([scope.organizationId, scope.agentId]);
}
