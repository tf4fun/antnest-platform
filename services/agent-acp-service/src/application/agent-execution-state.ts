import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type {
  AgentConfiguration,
  ExecutionIdentity,
  PublicExecutionConfiguration,
} from "../domain/execution-configuration.js";
import type { AgentExecutionStateView } from "../domain/agent-execution-state.js";
import type {
  AgentExecutionStatePort,
  ExecutionStateSink,
} from "../ports/agent-execution-state.js";
import type { RuntimeProtectionRepository } from "../ports/execution-repository.js";
import type { ExecutionDirectory } from "./execution-directory.js";
import type { RunSupervisor } from "./run-supervisor.js";

type Dependencies = {
  directory: ExecutionDirectory;
  supervisor: RunSupervisor;
  protection: RuntimeProtectionRepository;
};
type Current = { agent: AgentConfiguration; configuration: PublicExecutionConfiguration };
const CONTROL_FIELDS = new Set([
  "principal_ids",
  "access_revision",
  "accepting_runs",
  "unavailable_reason",
  "operation_id",
]);

export class AgentExecutionState implements AgentExecutionStatePort {
  public constructor(private readonly dependencies: Dependencies) {}

  public async read(
    identity: ExecutionIdentity,
    send: ExecutionStateSink,
    signal: AbortSignal,
  ): Promise<void> {
    const lifetime = AbortSignal.any([signal, this.dependencies.supervisor.stopSignal]);
    let revision = 0;
    const invalidate = () => {
      revision += 1;
    };
    const stopConfiguration = this.dependencies.directory.subscribe(
      identity.organizationId,
      invalidate,
    );
    const stopOccupancy = this.dependencies.supervisor.subscribe(identity, invalidate);
    try {
      while (!lifetime.aborted) {
        const observed = revision;
        const state = await this.snapshot(identity, lifetime);
        lifetime.throwIfAborted();
        if (observed !== revision) continue;
        await send(this.current(identity) === null ? denied(identity) : state, lifetime);
        return;
      }
      lifetime.throwIfAborted();
    } finally {
      stopConfiguration();
      stopOccupancy();
    }
  }

  public async watch(
    identity: ExecutionIdentity,
    send: ExecutionStateSink,
    caller: AbortSignal,
  ): Promise<void> {
    const revoked = new AbortController();
    const lifetime = AbortSignal.any([
      caller,
      this.dependencies.supervisor.stopSignal,
      revoked.signal,
    ]);
    let wake = Promise.withResolvers<void>();
    let revision = 0;
    let observed = -1;
    const changed = () => {
      revision += 1;
      wake.resolve();
    };
    const changedConfiguration = () => {
      try {
        if (this.current(identity) === null)
          revoked.abort(new DomainError("access_denied", "Agent access revoked"));
      } catch (error) {
        revoked.abort(error);
      }
      changed();
    };
    const stopConfiguration = this.dependencies.directory.subscribe(
      identity.organizationId,
      changedConfiguration,
    );
    const stopOccupancy = this.dependencies.supervisor.subscribe(identity, changed);
    const stopped = () => {
      stopConfiguration();
      stopOccupancy();
      wake.resolve();
    };
    lifetime.addEventListener("abort", stopped, { once: true });
    wake.resolve();
    let last: string | undefined;
    try {
      while (!lifetime.aborted) {
        await wake.promise;
        wake = Promise.withResolvers<void>();
        lifetime.throwIfAborted();
        if (observed === revision) continue;
        const reading = revision;
        const state = await this.snapshot(identity, lifetime);
        if (reading !== revision) continue;
        lifetime.throwIfAborted();
        const visible = this.current(identity) === null ? denied(identity) : state;
        const encoded = JSON.stringify(visible);
        if (encoded !== last) await send(visible, lifetime);
        last = encoded;
        observed = reading;
        if (!visible.access_allowed) return;
      }
      lifetime.throwIfAborted();
    } catch (error) {
      if (caller.aborted) return;
      if (revoked.signal.aborted && accessDenied(revoked.signal.reason)) {
        await send(
          denied(identity),
          AbortSignal.any([caller, this.dependencies.supervisor.stopSignal]),
        );
        return;
      }
      throw error;
    } finally {
      stopped();
      lifetime.removeEventListener("abort", stopped);
    }
  }

  private current(identity: ExecutionIdentity): Current | null {
    this.dependencies.supervisor.stopSignal.throwIfAborted();
    try {
      return this.dependencies.directory.inspect(identity);
    } catch (error) {
      if (accessDenied(error)) return null;
      throw error;
    }
  }

  private async snapshot(
    identity: ExecutionIdentity,
    signal: AbortSignal,
  ): Promise<AgentExecutionStateView> {
    signal.throwIfAborted();
    const current = this.current(identity);
    if (current === null) return denied(identity);
    const slot = this.dependencies.supervisor.occupancy(identity);
    if (slot.busy || !current.agent.accepting_runs) return stateView(current, slot, false);
    const protectedRuntime = await this.dependencies.protection.hasUnstoppedRuntimeCalls(
      {
        organizationId: identity.organizationId,
        agentId: identity.agentId,
        runtimeRevision: current.agent.runtime?.runtime_revision ?? null,
      },
      signal,
    );
    signal.throwIfAborted();
    // Both callers observe changes before reading and discard a view invalidated
    // during the database query or before synchronous transport enqueue.
    return stateView(current, this.dependencies.supervisor.occupancy(identity), protectedRuntime);
  }
}

function stateView(
  current: Current,
  slot: { busy: boolean; activeSessionId: string | null },
  protectedRuntime: boolean,
): AgentExecutionStateView {
  const unavailable = !current.agent.accepting_runs;
  const shared = {
    agent_id: current.agent.agent_id,
    access_allowed: true as const,
    configuration_revision: configurationRevision(current),
  };
  if (slot.busy)
    return {
      ...shared,
      availability: "busy",
      active_session_id: slot.activeSessionId,
      unavailable_reason: unavailable ? "agent_unavailable" : null,
    };
  if (unavailable || protectedRuntime)
    return {
      ...shared,
      availability: "offline",
      active_session_id: null,
      unavailable_reason: unavailable ? "agent_unavailable" : "runtime_barrier_required",
    };
  return { ...shared, availability: "ready", active_session_id: null, unavailable_reason: null };
}

function configurationRevision({ agent, configuration }: Current): string {
  const settings = Object.fromEntries(
    Object.entries(agent).filter(([key]) => !CONTROL_FIELDS.has(key)),
  );
  const used = new Set(configuration.models.map((model) => model.connection_id));
  const providers = configuration.providers
    .filter((provider) => used.has(provider.connection_id))
    .map((provider) => ({ ...provider, credential_revision: undefined }));
  return createHash("sha256")
    .update(JSON.stringify({ settings, models: configuration.models, providers }))
    .digest("hex");
}

function denied(identity: ExecutionIdentity): AgentExecutionStateView {
  return {
    agent_id: identity.agentId,
    access_allowed: false,
    availability: "offline",
    active_session_id: null,
    configuration_revision: null,
    unavailable_reason: "access_denied",
  };
}

function accessDenied(error: unknown): boolean {
  return error instanceof DomainError && error.code === "access_denied";
}
