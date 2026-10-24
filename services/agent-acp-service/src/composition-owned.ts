import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { buildAgentComponents } from "./composition-agent.js";
import { buildLearningPipeline } from "./composition-learning.js";
import { AgentGenerations, type AgentGeneration } from "./application/agent-generations.js";
import { AgentApplicationRouter } from "./application/agent-application-router.js";
import { AgentSettlement } from "./application/agent-settlement.js";
import { AgentExecutionState } from "./application/agent-execution-state.js";
import { RuntimeSkillCommands } from "./application/runtime-skill-commands.js";
import { TemporarySkills } from "./application/temporary-skills.js";
import { TemporarySkillCleanupWorker } from "./application/temporary-skill-cleanup-worker.js";
import type { LearningPausedRecovery } from "./application/learning-paused-recovery.js";
import type { OwnerRegistration } from "./application/owner-incarnation.js";
import { PostgresAgentLeases } from "./adapters/postgres/agent-leases.js";
import { PostgresAgentStartup } from "./adapters/postgres/agent-startup.js";
import {
  createLegacyAgentRepositories,
  createOwnedAgentRepositories,
} from "./adapters/postgres/agent-repositories.js";
import {
  createLegacyLearningRepositories,
  createOwnedLearningRepositories,
} from "./adapters/postgres/learning-repositories.js";
import type { PostgresExecutionConfiguration } from "./adapters/postgres/execution-configuration.js";
import { SecretBox } from "./adapters/postgres/secret-box.js";
import type { PostgresWorkerLock } from "./adapters/postgres/worker-lock.js";
import { RuntimeSkillTemporaryClient } from "./adapters/runtime-skill-temporary-client.js";
import { RuntimeSkillMaintenanceSigner } from "./adapters/runtime-skill-maintenance-signer.js";
import { AgentOwnershipLostError, type AgentOwnershipScope } from "./domain/agent-ownership.js";
import { DomainError } from "./domain/errors.js";
import {
  publicExecutionConfiguration,
  type PublicExecutionConfiguration,
  type ExecutionAccessSnapshot,
} from "./domain/execution-configuration.js";
import { parseAgentSettlement } from "./domain/agent-settlement.js";
import type { AcpApplicationPort } from "./ports/acp-application.js";
import type { AgentSettlementPort } from "./ports/agent-settlement.js";
import type { AgentExecutionStatePort } from "./ports/agent-execution-state.js";
import type { SkillCommandsPort } from "./ports/skill-commands.js";
import { ModelTransportCleanupError } from "./ports/model.js";

type Graph = ReturnType<typeof buildAgentComponents>;
type Options = Omit<
  Parameters<typeof buildAgentComponents>[0],
  | "repositories"
  | "learningRepositories"
  | "ownershipLost"
  | "beforeTemporaryCleanup"
  | "retainModelRequest"
> & {
  registration: OwnerRegistration;
  configuration: PostgresExecutionConfiguration;
  legacy: ReturnType<typeof createLegacyAgentRepositories>;
  legacyRecovery: Graph["recovery"];
  learningChanged: () => void;
};
type Entry = {
  scope: AgentOwnershipScope;
  generation: AgentGeneration<AcpApplicationPort>;
  graph: Graph;
  signal: AbortSignal;
  legacyCleanup: TemporarySkillCleanupWorker;
  legacyPaused: LearningPausedRecovery | undefined;
  releaseLegacyTemporary: (signal: AbortSignal) => Promise<void>;
  settlement: AgentSettlement;
  executionState: AgentExecutionState;
  commands: RuntimeSkillCommands;
  started: boolean;
  stopping: boolean;
};
const key = (scope: AgentOwnershipScope) => JSON.stringify([scope.organizationId, scope.agentId]);
const unavailable = () => new DomainError("agent_unavailable", "Agent execution is unavailable");

/** Production ownership boundary. A graph and all its users share one immutable generation. */
export class OwnedAgentComponents {
  private readonly generations: AgentGenerations<AcpApplicationPort>;
  private readonly inventory: PostgresAgentStartup;
  private readonly entries = new Map<string, Entry>();
  private readonly cleanupFailures: unknown[] = [];
  private started = false;
  private stopped = false;
  private shutdownPromise: Promise<void> | undefined;
  public readonly application: AcpApplicationPort;
  public readonly settlement: AgentSettlementPort;
  public readonly executionState: AgentExecutionStatePort;
  public readonly skillCommands: SkillCommandsPort;

  public constructor(private readonly options: Options) {
    this.generations = new AgentGenerations({
      registration: options.registration,
      leases: new PostgresAgentLeases(options.kernel),
    });
    this.inventory = new PostgresAgentStartup(options.kernel);
    this.application = new AgentApplicationRouter({
      access: options.access,
      generations: this.generations,
    });
    this.settlement = {
      settle: async (input, signal) => {
        const request = parseAgentSettlement(input);
        const scope = { organizationId: request.organization_id, agentId: request.agent_id };
        // Lifecycle authorization is deliberately separate from user/Prompt admission.
        this.options.directory.closedAgent({
          ...scope,
          operationId: request.operation_id,
          minimumRevision: request.minimum_revision,
        });
        return this.dispatch(scope, (entry) => entry.settlement.settle(request, signal));
      },
    };
    this.executionState = {
      read: async (identity, send, signal) => {
        await options.access.assert(identity);
        return this.dispatch(identity, (entry) =>
          entry.executionState.read(identity, send, signal),
        );
      },
      watch: async (identity, send, signal) => {
        await options.access.assert(identity);
        return this.dispatch(identity, (entry) =>
          entry.executionState.watch(identity, send, signal),
        );
      },
    };
    this.skillCommands = {
      read: async (binding, signal) => {
        await options.access.assert(binding);
        return this.dispatch(binding, (entry) =>
          entry.commands.read(binding, AbortSignal.any([signal, entry.signal])),
        );
      },
    };
    options.ownershipSignal.addEventListener(
      "abort",
      () => this.stop(options.ownershipSignal.reason),
      { once: true },
    );
    if (options.ownershipSignal.aborted) this.stop(options.ownershipSignal.reason);
  }

  public async recoverStartup(worker: PostgresWorkerLock): Promise<void> {
    for (const scope of await this.inventory.inspect()) {
      this.options.ownershipSignal.throwIfAborted();
      if (scope.protected) {
        this.reportUnavailable(scope);
        continue;
      }
      await worker.pauseAbandonedLearningTasks(scope);
      await this.options.legacy.permissions.cancelAbandoned(scope);
      await this.options.legacyRecovery.recoverLegacyScope(scope, this.options.ownershipSignal);
    }
  }

  public revoke(snapshot: ExecutionAccessSnapshot): void {
    for (const entry of this.entries.values()) {
      if (entry.scope.organizationId !== snapshot.organization_id) continue;
      entry.graph.supervisor.revokeAccess(snapshot);
    }
  }

  public async prepare(next: PublicExecutionConfiguration): Promise<void> {
    this.options.ownershipSignal.throwIfAborted();
    if (this.stopped) throw unavailable();
    this.revoke(next);
    for (const entry of this.entries.values())
      if (entry.scope.organizationId === next.organization_id)
        entry.graph.learningGate.syncOrganization(next.organization_id, next.agents);
    const agentIds = new Set(next.agents.map((agent) => agent.agent_id));
    for (const entry of this.entries.values())
      if (entry.scope.organizationId === next.organization_id && !agentIds.has(entry.scope.agentId))
        this.retire(entry);
    for (const agent of next.agents) {
      const scope = { organizationId: next.organization_id, agentId: agent.agent_id };
      try {
        const generation = await this.generations.prepare(scope, async (captured) => {
          const signal = AbortSignal.any([this.options.ownershipSignal, captured.signal]);
          signal.throwIfAborted();
          await this.inventory.assertAvailable(captured.authority.fence);
          const original = await this.options.configuration.loadOwnedAuthority(
            captured.authority.fence,
          );
          if (original === null || !isDeepStrictEqual(publicExecutionConfiguration(original), next))
            throw configurationUnavailable();
          const entry = this.build(scope, captured, signal);
          this.entries.set(key(scope), entry);
          const current = await this.options.configuration.loadOwnedAuthority(
            captured.authority.fence,
          );
          signal.throwIfAborted();
          if (!isDeepStrictEqual(current, original)) throw configurationUnavailable();
          return entry.graph.application;
        });
        // prepare() is idempotent for a healthy graph. Every publication must
        // nevertheless validate the new sealed payload and this original fence.
        await generation.dispatch(async () => {
          const current = await this.options.configuration.loadOwnedAuthority(
            generation.authority.fence,
          );
          if (current === null || !isDeepStrictEqual(publicExecutionConfiguration(current), next))
            throw configurationUnavailable();
        });
        this.entries
          .get(key(scope))
          ?.graph.learningGate.syncOrganization(next.organization_id, next.agents);
      } catch (error) {
        this.options.ownershipSignal.throwIfAborted();
        if (!(error instanceof AgentOwnershipLostError)) throw error;
        this.reportUnavailable(scope);
      }
    }
  }

  public async beforeAck(next: PublicExecutionConfiguration): Promise<void> {
    const captured = next.agents
      .filter((agent) => agent.accepting_runs)
      .map((agent) =>
        this.capture({ organizationId: next.organization_id, agentId: agent.agent_id }),
      );
    const authority = await this.options.configuration.loadAuthority(next.organization_id);
    if (authority === null || !isDeepStrictEqual(publicExecutionConfiguration(authority), next))
      throw configurationUnavailable();
    await this.options.configuration.confirmOwnedAuthority(
      authority,
      captured.map((entry) => entry.generation.authority.fence),
    );
    for (const entry of captured)
      if (this.capture(entry.scope) !== entry) throw configurationUnavailable();
  }

  public published(organizationId: string): void {
    if (!this.started || this.stopped) return;
    for (const entry of this.entries.values())
      if (entry.scope.organizationId === organizationId) this.startEntry(entry);
  }
  public start(): void {
    this.started = true;
    for (const entry of this.entries.values()) this.startEntry(entry);
  }
  public withdraw(organizationId: string): void {
    for (const entry of this.entries.values())
      if (entry.scope.organizationId === organizationId) this.retire(entry);
  }
  public stop(reason: unknown): void {
    this.stopped = true;
    for (const entry of this.entries.values()) this.retire(entry, reason);
  }
  public shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.stop(new Error("Agent service is shutting down"));
      try {
        await this.generations.drain();
      } catch (error) {
        this.cleanupFailures.push(error);
      }
      if (this.cleanupFailures.length > 0)
        throw new AggregateError(this.cleanupFailures, "Owned Agent cleanup failed");
    })();
    return this.shutdownPromise;
  }

  public async beginSourceRead(scope: AgentOwnershipScope, signal: AbortSignal) {
    const entry = this.capture(scope);
    let finish: (() => void) | undefined;
    try {
      return await entry.generation.dispatch(async () => {
        const lease = await entry.graph.learningGate.beginSourceRead(
          scope,
          AbortSignal.any([signal, entry.signal]),
        );
        const done = Promise.withResolvers<void>();
        let finished = false;
        finish = () => {
          if (finished) return;
          finished = true;
          try {
            lease.finish();
          } finally {
            done.resolve();
          }
        };
        entry.generation.retainRun(done.promise);
        return { signal: lease.signal, finish };
      });
    } catch (error) {
      // dispatch can lose authority after acquisition but before the caller
      // receives its release handle. The acquisition still belongs to us.
      finish?.();
      throw error;
    }
  }

  private capture(scope: AgentOwnershipScope): Entry {
    const generation = this.generations.capture(scope);
    const entry = this.entries.get(key(scope));
    if (entry === undefined || entry.generation !== generation || entry.signal.aborted)
      throw unavailable();
    return entry;
  }
  private dispatch<T>(
    scope: AgentOwnershipScope,
    operation: (entry: Entry) => Promise<T>,
  ): Promise<T> {
    const entry = this.capture(scope);
    return entry.generation.dispatch(() => operation(entry));
  }

  private build(
    scope: AgentOwnershipScope,
    generation: AgentGeneration<AcpApplicationPort>,
    signal: AbortSignal,
  ): Entry {
    const { config, kernel, runtimeConnections, telemetry, directory } = this.options;
    const repositories = createOwnedAgentRepositories(
      kernel,
      new SecretBox(config.clientMcpKey),
      generation.authority,
    );
    const callbacks = {
      onSettled: (requestId: string) => runtimeConnections.releaseOperation(requestId),
      onCommitted: this.options.learningChanged,
    };
    const learningEnabled =
      config.skillLearningControllerUrl !== undefined &&
      config.skillMaintenanceSigning !== undefined;
    const learningRepositories = learningEnabled
      ? createOwnedLearningRepositories(kernel, generation.authority, callbacks)
      : undefined;
    // Until multi-instance stop-proof recovery is delivered, the retained
    // global worker lock owns legacy writes. Agent loss cancels dispatch but
    // must still allow the original legacy claim's cancellation receipt.
    const legacy = createLegacyAgentRepositories(
      kernel,
      new SecretBox(config.clientMcpKey),
      this.options.ownershipSignal,
    );
    const signer =
      config.skillMaintenanceSigning === undefined
        ? undefined
        : new RuntimeSkillMaintenanceSigner(
            config.skillMaintenanceSigning.kid,
            config.skillMaintenanceSigning.privateKey,
          );
    const legacyTemporary = new TemporarySkills(
      legacy.temporarySkills,
      new RuntimeSkillTemporaryClient(signer, runtimeConnections, undefined, (target) =>
        directory.runtimeForCleanup(target),
      ),
      telemetry,
    );
    const releaseLegacyTemporary = async (lifetime: AbortSignal) => {
      let after: string | null = null;
      for (;;) {
        lifetime.throwIfAborted();
        const pending = await legacy.temporarySkills.next(after, lifetime, scope);
        if (pending === null) return;
        await legacyTemporary.release(pending, lifetime);
        after = pending.runId;
      }
    };
    const lose = (error: Error) => {
      const entry = this.entries.get(key(scope));
      if (entry?.generation === generation) this.retire(entry, error);
      else void this.generations.closeScope(scope, error);
    };
    const retainModelRequest = (original: Promise<unknown>): void => {
      // Observe the original result before generation tracking deletes it.
      // Business errors and expected cancellation are owned by the caller.
      void original.catch((error: unknown) => {
        if (error instanceof ModelTransportCleanupError) this.cleanupFailures.push(error);
      });
      generation.retainRun(original);
    };
    const graph = buildAgentComponents({
      ...this.options,
      repositories,
      learningRepositories,
      ownershipSignal: signal,
      recoveryRequired: lose,
      ownershipLost: lose,
      retainModelRequest,
      beforeTemporaryCleanup: (_target, lifetime) => releaseLegacyTemporary(lifetime),
    });
    const legacyCleanup = new TemporarySkillCleanupWorker({
      skills: {
        next: (after, lifetime) => legacy.temporarySkills.next(after, lifetime, scope),
        release: (pending, lifetime) => legacyTemporary.release(pending, lifetime),
      },
      gate: graph.learningGate,
      report: (outcome) => telemetry.count("antnest.acp.skill_temporary_cleanup", { outcome }),
    });
    const legacyPipeline = learningEnabled
      ? buildLearningPipeline({
          ...this.options,
          learningRepositories: createLegacyLearningRepositories(
            kernel,
            this.options.ownershipSignal,
            callbacks,
          ),
          rawTools: graph.rawTools,
          gate: graph.learningGate,
          temporarySkills: legacyTemporary,
          recoveryScope: scope,
          retainModelRequest,
        })
      : undefined;
    const entry: Entry = {
      scope,
      generation,
      graph,
      signal,
      legacyCleanup,
      legacyPaused: legacyPipeline?.paused,
      releaseLegacyTemporary,
      started: false,
      stopping: false,
      settlement: new AgentSettlement({
        directory,
        supervisor: graph.supervisor,
        learning: graph.learningGate,
        protection: repositories.executions,
        temporarySkills: {
          releaseAgent: async (target, lifetime) => {
            await releaseLegacyTemporary(lifetime);
            await graph.temporarySkills.releaseAgent(target, lifetime);
          },
        },
        now: this.options.now,
      }),
      executionState: new AgentExecutionState({
        directory,
        supervisor: graph.supervisor,
        protection: repositories.executions,
      }),
      commands: new RuntimeSkillCommands({
        directory,
        gate: graph.learningGate,
        runtime: graph.rawTools,
        busy: (binding) => graph.supervisor.occupancy(binding).busy,
      }),
    };
    signal.addEventListener("abort", () => this.stopEntry(entry), { once: true });
    if (signal.aborted) this.stopEntry(entry);
    return entry;
  }

  private startEntry(entry: Entry): void {
    if (entry.started || this.stopped || entry.signal.aborted) return;
    try {
      if (this.capture(entry.scope) !== entry) return;
    } catch {
      return;
    }
    entry.started = true;
    const work = [
      entry.graph.temporarySkillCleanupWorker.run(entry.signal),
      entry.legacyCleanup.run(entry.signal),
    ];
    if (entry.graph.learningWorker !== undefined)
      work.push(entry.graph.learningWorker.run(entry.signal));
    if (entry.legacyPaused !== undefined) work.push(this.recoverLegacyLearning(entry));
    for (const original of work)
      entry.generation.retainRun(
        original.catch((error: unknown) => {
          if (!entry.signal.aborted) {
            this.options.telemetry.log(
              "warn",
              "agent_background_failed",
              { agent_id: entry.scope.agentId },
              error,
            );
            this.retire(entry, error);
          }
        }),
      );
  }
  private async recoverLegacyLearning(entry: Entry): Promise<void> {
    let after: string | null = null;
    for (;;) {
      try {
        entry.signal.throwIfAborted();
        const page = await entry.legacyPaused!.next(after, entry.signal);
        after = page.exhausted ? null : page.after;
        if (page.exhausted) await delay(2000, undefined, { signal: entry.signal });
      } catch (error) {
        if (entry.signal.aborted) return;
        throw error;
      }
    }
  }
  private retire(entry: Entry, cause: unknown = new AgentOwnershipLostError()): void {
    this.stopEntry(entry);
    void this.generations.closeScope(entry.scope, cause);
  }
  private stopEntry(entry: Entry): void {
    if (entry.stopping) return;
    entry.stopping = true;
    const reason: unknown = entry.signal.reason;
    entry.graph.supervisor.stop(reason instanceof Error ? reason : new AgentOwnershipLostError());
    entry.generation.retainRun(
      entry.graph.supervisor.shutdown().catch((error: unknown) => {
        this.cleanupFailures.push(error);
      }),
    );
  }
  private reportUnavailable(scope: AgentOwnershipScope): void {
    this.options.telemetry.log("warn", "agent_startup_protected", {
      organization_id: scope.organizationId,
      agent_id: scope.agentId,
    });
  }
}

function configurationUnavailable() {
  return new DomainError(
    "configuration_unavailable",
    "Execution ownership or sealed configuration changed",
  );
}
