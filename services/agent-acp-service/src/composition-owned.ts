import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { buildAgentComponents } from "./composition-agent.js";
import { buildLearningPipeline } from "./composition-learning.js";
import { AgentGenerations, type AgentGeneration } from "./application/agent-generations.js";
import type { AgentAssignment } from "./application/agent-assignment.js";
import { AgentApplicationRouter } from "./application/agent-application-router.js";
import { AgentSettlement } from "./application/agent-settlement.js";
import { AgentExecutionState } from "./application/agent-execution-state.js";
import { RuntimeSkillCommands } from "./application/runtime-skill-commands.js";
import { TemporarySkills } from "./application/temporary-skills.js";
import { TemporarySkillCleanupWorker } from "./application/temporary-skill-cleanup-worker.js";
import type { LearningPausedRecovery } from "./application/learning-paused-recovery.js";
import type { OwnerRegistration } from "./application/owner-incarnation.js";
import type { LocalExecutionPublication } from "./application/execution-directory.js";
import type { OwnerInspection } from "./application/owner-inspection.js";
import { PostgresAgentLeases } from "./adapters/postgres/agent-leases.js";
import { PostgresAgentStartup } from "./adapters/postgres/agent-startup.js";
import { PostgresOwnerRecovery } from "./adapters/postgres/owner-recovery.js";
import type { RunOwnerAuthority } from "./adapters/postgres/run-write-authority.js";
import {
  OwnerInspectionAttemptError,
  type RuntimeControllerIncarnations,
} from "./adapters/runtime-controller-incarnations.js";
import {
  createLegacyAgentRepositories,
  createFencedLegacyAgentRepositories,
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
import {
  AgentOwnershipLostError,
  type AgentOwnershipScope,
  type AgentOwnershipFence,
} from "./domain/agent-ownership.js";
import { DomainError } from "./domain/errors.js";
import {
  publicExecutionConfiguration,
  type PublicExecutionConfiguration,
  type ExecutionAccessSnapshot,
} from "./domain/execution-configuration.js";
import {
  parseAgentSettlement,
  type AgentSettlementRequest,
  type AgentSettlementResult,
} from "./domain/agent-settlement.js";
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
  assignment?: AgentAssignment;
  ownerInspection?: Pick<RuntimeControllerIncarnations, "inspect">;
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
  private readonly modelCleanupFailures = new Map<string, ModelTransportCleanupError[]>();
  private readonly retiring = new Map<string, Set<Promise<void>>>();
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
        let entry: Entry;
        try {
          entry = this.capture(scope);
        } catch (error) {
          if (
            error instanceof AgentOwnershipLostError ||
            (error instanceof DomainError && error.code === "agent_unavailable")
          )
            return this.settleProtected(request, signal);
          throw error;
        }
        return entry.generation.dispatch(() => entry.settlement.settle(request, signal));
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
      if (this.options.assignment !== undefined) {
        if (!this.options.assignment.owns(scope)) continue;
        try {
          await this.generations.runControl(
            scope,
            async (authority, original) => {
              const signal = AbortSignal.any([this.options.ownershipSignal, original]);
              await this.recoverPredecessors(authority, signal);
              const state = await this.inventory.settlement(authority.fence);
              signal.throwIfAborted();
              if (state.localUncertain || state.runtimeProtected) this.reportUnavailable(scope);
            },
            this.options.ownershipSignal,
          );
        } catch (error) {
          this.options.ownershipSignal.throwIfAborted();
          if (!(error instanceof AgentOwnershipLostError)) throw error;
          this.reportUnavailable(scope);
        }
        // A current lease cannot supply a missing original stop proof. Legacy
        // inventory remains unchanged, including scopes absent from publication.
        continue;
      }
      if (scope.protected) {
        this.reportUnavailable(scope);
        continue;
      }
      await worker.pauseAbandonedLearningTasks(scope);
      await this.options.legacy.permissions.cancelAbandoned(scope);
      await this.options.legacyRecovery.recoverLegacyScope(scope, this.options.ownershipSignal);
    }
  }

  private async settleProtected(
    request: AgentSettlementRequest,
    signal?: AbortSignal,
  ): Promise<AgentSettlementResult> {
    const operation = {
      organizationId: request.organization_id,
      agentId: request.agent_id,
      operationId: request.operation_id,
      minimumRevision: request.minimum_revision,
    };
    const initial = this.options.directory.closedAgent(operation);
    if (this.options.assignment !== undefined && !this.options.assignment.owns(operation))
      return { applied_revision: initial.revision, outcome: "not_settled" };
    const deadline = Date.parse(request.deadline_at);
    const waiting = new AbortController();
    const lifetime = AbortSignal.any([
      waiting.signal,
      this.options.ownershipSignal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const expired = () => lifetime.aborted || this.options.now().getTime() >= deadline;
    const current = () => {
      this.options.ownershipSignal.throwIfAborted();
      const latest = this.options.directory.closedAgent(operation);
      if (!isDeepStrictEqual(latest.agent.runtime, initial.agent.runtime))
        throw new DomainError("agent_operation_conflict", "Runtime changed during settlement");
      return latest;
    };
    if (expired()) return { applied_revision: current().revision, outcome: "not_settled" };
    const timer = setTimeout(
      () => waiting.abort(),
      Math.max(0, Math.min(deadline - this.options.now().getTime(), 2_147_483_647)),
    );
    timer.unref();
    try {
      const outcome = await this.generations.runControl(
        operation,
        async (authority, original) => {
          original.throwIfAborted();
          const published = current();
          const saved = await this.options.configuration.loadOwnedAuthority(authority.fence);
          original.throwIfAborted();
          const agent =
            saved === null
              ? undefined
              : publicExecutionConfiguration(saved).agents.find(
                  (candidate) => candidate.agent_id === operation.agentId,
                );
          if (
            saved === null ||
            saved.revision !== published.revision ||
            !isDeepStrictEqual(agent, published.agent)
          )
            throw configurationUnavailable();
          // The control generation has joined this process's original initializer,
          // tasks and release. Durable proof independently covers remote predecessors.
          const inventory = await this.inventory.settlement(authority.fence);
          original.throwIfAborted();
          current();
          return inventory.localUncertain
            ? ("not_settled" as const)
            : inventory.runtimeProtected
              ? ("runtime_barrier_required" as const)
              : ("settled" as const);
        },
        lifetime,
      );
      const latest = current();
      return { applied_revision: latest.revision, outcome: expired() ? "not_settled" : outcome };
    } catch (error) {
      const latest = current();
      if (expired() || error instanceof AgentOwnershipLostError)
        return { applied_revision: latest.revision, outcome: "not_settled" };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  public revoke(snapshot: ExecutionAccessSnapshot): Promise<void> {
    const originals: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.scope.organizationId !== snapshot.organization_id) continue;
      originals.push(entry.graph.supervisor.revokeAccess(snapshot));
    }
    return Promise.all(originals).then(() => undefined);
  }

  public async joinRetirements(organizationId: string): Promise<void> {
    const pending = this.retiring.get(organizationId);
    while (pending !== undefined && pending.size > 0) {
      const results = await Promise.allSettled([...pending]);
      const errors = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason as unknown),
          "Retired Agent cleanup failed",
        );
    }
    // Generation drain joins original calls but leaves their result to the
    // caller. A failed native cleanup must also prevent publication ACKs.
    const failures = this.modelCleanupFailures.get(organizationId);
    if (failures?.length) throw new AggregateError(failures, "Retired Agent model cleanup failed");
  }

  public async prepare(next: PublicExecutionConfiguration): Promise<void> {
    this.options.ownershipSignal.throwIfAborted();
    if (this.stopped) throw unavailable();
    // Publication's revocation barrier owns the join outside this preparation.
    void this.revoke(next);
    for (const entry of this.entries.values())
      if (entry.scope.organizationId === next.organization_id)
        entry.graph.learningGate.syncOrganization(next.organization_id, next.agents);
    const assigned = next.agents.filter(
      (agent) =>
        this.options.assignment?.owns({
          organizationId: next.organization_id,
          agentId: agent.agent_id,
        }) ?? true,
    );
    const agentIds = new Set(assigned.map((agent) => agent.agent_id));
    for (const entry of this.entries.values())
      if (entry.scope.organizationId === next.organization_id && !agentIds.has(entry.scope.agentId))
        this.retire(entry);
    for (const agent of assigned) {
      const scope = { organizationId: next.organization_id, agentId: agent.agent_id };
      try {
        const generation = await this.generations.prepare(scope, async (captured) => {
          const signal = AbortSignal.any([this.options.ownershipSignal, captured.signal]);
          signal.throwIfAborted();
          await this.recoverPredecessors(captured.authority, signal);
          await this.inventory.assertAvailable(captured.authority.fence);
          if (this.options.assignment !== undefined) {
            const state = await this.inventory.settlement(captured.authority.fence);
            if (state.localUncertain || state.runtimeProtected) throw new AgentOwnershipLostError();
          }
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

  private async recoverPredecessors(
    authority: RunOwnerAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const recovery = new PostgresOwnerRecovery(this.options.kernel, authority);
    let stage: "list" | "inspect" | "recover" = "list";
    let kind: "run" | "learning" = "run";
    let reason = "recovery_unavailable";
    type Stopped = Extract<OwnerInspection, { state: "stopped" }>;
    const proofs = new Map<string, Stopped>();
    const inspect = async (item: { registration: OwnerRegistration; inspection?: Stopped }) => {
      signal.throwIfAborted();
      stage = "inspect";
      reason = "inspection_unavailable";
      const identity = JSON.stringify([
        item.registration.registration_id,
        item.registration.member_id,
        item.registration.incarnation_id,
      ]);
      let inspection = item.inspection ?? proofs.get(identity);
      if (inspection === undefined) {
        const inspector = this.options.ownerInspection;
        if (inspector === undefined) throw new AgentOwnershipLostError();
        // Inventory SQL has completed. Join this original authenticated request
        // and its cleanup before recovery SQL; permanent proof needs no RPC.
        const observed = await inspector.inspect(item.registration, signal);
        if (observed.state !== "stopped") {
          reason = observed.state === "running" ? "predecessor_running" : "predecessor_unknown";
          throw new AgentOwnershipLostError();
        }
        inspection = observed;
      }
      signal.throwIfAborted();
      proofs.set(identity, inspection);
      stage = "recover";
      reason = "recovery_unavailable";
      return inspection;
    };
    try {
      signal.throwIfAborted();
      const work = await recovery.listPredecessors();
      for (const item of work) {
        const inspection = await inspect(item);
        signal.throwIfAborted();
        await recovery.recoverRun({
          runId: item.runId,
          inspection,
          recoveredAt: this.options.now(),
        });
      }
      signal.throwIfAborted();
      kind = "learning";
      stage = "list";
      // Discover after Run recovery so a shared predecessor's newly accepted
      // permanent proof can be reused from the same durable inventory.
      const learning = await recovery.listLearningPredecessors();
      for (const item of learning) {
        const inspection = await inspect(item);
        signal.throwIfAborted();
        await recovery.recoverLearning({
          taskId: item.taskId,
          claimId: item.claimId,
          generation: item.generation,
          inspection,
          recoveredAt: this.options.now(),
        });
      }
    } catch (error) {
      const cleanupFailed = error instanceof OwnerInspectionAttemptError && error.cleanupFailed;
      if (cleanupFailed) this.cleanupFailures.push(error);
      this.options.ownershipSignal.throwIfAborted();
      this.options.telemetry.log("warn", "agent_predecessor_recovery_unavailable", {
        organization_id: authority.fence.organizationId,
        agent_id: authority.fence.agentId,
        stage,
        kind,
        reason,
        cleanup_failed: cleanupFailed,
      });
      // The generation manager owns closing and joining this initializer. Do
      // not join our own generation here or fail other healthy Agent scopes.
      throw new AgentOwnershipLostError();
    }
  }

  public async localPublicationFences(
    publication: LocalExecutionPublication,
    signal: AbortSignal,
  ): Promise<readonly AgentOwnershipFence[]> {
    const organizationId = publication.authority.organization_id;
    signal.throwIfAborted();
    publication.assertCurrent();
    await this.joinRetirements(organizationId);
    signal.throwIfAborted();
    const accepting = new Set(
      publication.configuration.agents
        .filter((agent) => agent.accepting_runs)
        .map((agent) => agent.agent_id),
    );
    const captured: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (
        entry.scope.organizationId !== organizationId ||
        !accepting.has(entry.scope.agentId) ||
        entry.stopping
      )
        continue;
      try {
        captured.push(this.capture(entry.scope));
      } catch (error) {
        if (
          !(error instanceof AgentOwnershipLostError) &&
          !(error instanceof DomainError && error.code === "agent_unavailable")
        )
          throw error;
      }
    }
    // A non-owner still proves its sealed view and completed revocations.
    const originals =
      captured.length === 0
        ? [this.options.configuration.loadAuthority(organizationId)]
        : captured.map((entry) =>
            entry.generation.dispatch(() =>
              this.options.configuration.loadOwnedAuthority(entry.generation.authority.fence),
            ),
          );
    const results = await Promise.allSettled(originals);
    // Capture may itself observe an expired generation and start retirement.
    await this.joinRetirements(organizationId);
    signal.throwIfAborted();
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (
      failures.length ||
      results.some(
        (result) =>
          result.status === "fulfilled" && !isDeepStrictEqual(result.value, publication.authority),
      )
    ) {
      const failure = configurationUnavailable();
      if (failures.length)
        failure.cause = new AggregateError(failures.map((result) => result.reason as unknown));
      throw failure;
    }
    const fences = captured.map((entry) => {
      if (
        this.capture(entry.scope) !== entry ||
        !isDeepStrictEqual(entry.generation.authority.registration, this.options.registration)
      )
        throw configurationUnavailable();
      return Object.freeze({ ...entry.generation.authority.fence });
    });
    publication.assertCurrent();
    return Object.freeze(
      fences.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)),
    );
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
    // Peer compatibility cleanup uses this Agent's current fence without
    // changing the historical record's null owner identity.
    const legacy =
      this.options.assignment === undefined
        ? createLegacyAgentRepositories(
            kernel,
            new SecretBox(config.clientMcpKey),
            this.options.ownershipSignal,
          )
        : createFencedLegacyAgentRepositories(
            kernel,
            new SecretBox(config.clientMcpKey),
            generation.authority,
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
        if (error instanceof ModelTransportCleanupError) {
          this.cleanupFailures.push(error);
          const failures = this.modelCleanupFailures.get(scope.organizationId) ?? [];
          failures.push(error);
          this.modelCleanupFailures.set(scope.organizationId, failures);
        }
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
    const legacyPipeline =
      learningEnabled && this.options.assignment === undefined
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
    // Automatic expiry/renewal loss also owns the manager's original close.
    // Register it without awaiting from the generation's own abort callback.
    signal.addEventListener("abort", () => this.retire(entry, signal.reason), { once: true });
    if (signal.aborted) this.retire(entry, signal.reason);
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
    const pending = this.retiring.get(entry.scope.organizationId) ?? new Set<Promise<void>>();
    this.retiring.set(entry.scope.organizationId, pending);
    const original = this.generations.closeScope(entry.scope, cause);
    if (pending.has(original)) return;
    pending.add(original);
    void original.then(
      () => pending.delete(original),
      (error: unknown) => {
        this.cleanupFailures.push(error);
      },
    );
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
