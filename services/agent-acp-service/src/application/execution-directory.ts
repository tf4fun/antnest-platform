import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../domain/errors.js";
import {
  authorizeConfiguredAgent,
  findConfiguredAgent,
  freezeExecutionConfiguration,
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  requireSameProviderRouting,
  type AgentConfiguration,
  type ExecutionConfiguration,
  type ExecutionIdentity,
  type PublicExecutionConfiguration,
} from "../domain/execution-configuration.js";
import {
  InvalidExecutionAuthorityError,
  type ExecutionConfigurationRepository,
} from "../ports/execution-configuration.js";
import type {
  PreparedRuntimeConnections,
  RuntimeConnectionAuthority,
} from "../ports/runtime-connections.js";
import type { RuntimeBinding } from "../domain/types.js";
import type { ProviderClients } from "./provider-clients.js";
import { InvalidationListeners } from "./invalidation-listeners.js";
import {
  executionPublication,
  parseExecutionPublication,
} from "../domain/execution-publication.js";

export type ExecutionDirectoryDependencies = {
  repository: ExecutionConfigurationRepository;
  clients: ProviderClients;
  runtimeConnections: RuntimeConnectionAuthority;
  onApplied: (configuration: PublicExecutionConfiguration) => Promise<void>;
  beforeAck?: (configuration: PublicExecutionConfiguration) => Promise<void>;
  beforePeerAck?: (publication: LocalExecutionPublication, deadline: Date) => Promise<void>;
  onUnavailable: (organizationId: string) => void;
  onPublished?: (organizationId: string) => void;
  onInvalidAuthority?: (organizationId: string) => void;
};

export type ClosedAgentOperation = {
  organizationId: string;
  agentId: string;
  minimumRevision: number;
  operationId: string;
};

export type LocalExecutionPublication = Readonly<{
  configuration: PublicExecutionConfiguration;
  authority: ExecutionConfiguration;
  assertCurrent: () => void;
}>;

class SupersededRestoration extends Error {}

export class ExecutionDirectory {
  private readonly configurations = new Map<string, PublicExecutionConfiguration>();
  private readonly publications = new Map<string, LocalExecutionPublication>();
  private readonly pending = new Map<
    string,
    { publication: Promise<void> | undefined; agents: Map<string, Promise<void>> }
  >();
  private readonly changes = new InvalidationListeners();

  public constructor(private readonly dependencies: ExecutionDirectoryDependencies) {}

  /** Startup only: restore owned authority before either listener is opened. */
  public async restore(signal: AbortSignal): Promise<void> {
    const restored: ExecutionConfiguration[] = [];
    const discard = (configuration: ExecutionConfiguration): void => {
      this.dependencies.clients.apply({ ...configuration, providers: [] });
      this.withdraw(configuration.organization_id);
    };
    try {
      signal.throwIfAborted();
      const organizations = await this.dependencies.repository.listOrganizations();
      signal.throwIfAborted();
      for (const organizationId of organizations) {
        await this.authorized(organizationId, undefined, async () => {
          let incoming: ExecutionConfiguration | null = null;
          try {
            signal.throwIfAborted();
            incoming = await this.dependencies.repository.loadAuthority(organizationId);
            signal.throwIfAborted();
            if (incoming === null) throw new InvalidExecutionAuthorityError();
            if (incoming.organization_id !== organizationId)
              throw new InvalidExecutionAuthorityError();
            let connections: PreparedRuntimeConnections;
            try {
              this.dependencies.clients.validate(incoming);
              connections = this.dependencies.runtimeConnections.prepare(incoming);
            } catch (error) {
              if (error instanceof DomainError && error.code === "configuration_conflict")
                throw new InvalidExecutionAuthorityError();
              throw error;
            }
            const expected = incoming;
            try {
              await this.publish(
                incoming,
                connections,
                async () => {
                  // A publication that committed during restoration always wins.
                  // Re-read the authenticated private payload, not public metadata.
                  const current = await this.dependencies.repository.loadAuthority(organizationId);
                  signal.throwIfAborted();
                  if (!isDeepStrictEqual(current, expected)) throw new SupersededRestoration();
                },
                signal,
              );
              restored.push(incoming);
            } finally {
              connections.rollback();
            }
          } catch (error) {
            if (incoming !== null) discard(incoming);
            else this.withdraw(organizationId);
            signal.throwIfAborted();
            if (
              error instanceof InvalidExecutionAuthorityError ||
              error instanceof SupersededRestoration
            ) {
              this.dependencies.onInvalidAuthority?.(organizationId);
              return;
            }
            throw error;
          }
        });
      }
      signal.throwIfAborted();
    } catch (error) {
      // A global dependency or ownership failure cannot leave partial clients
      // or sender files behind while startup is unwinding.
      for (const configuration of restored) discard(configuration);
      throw error;
    }
  }

  public async apply(
    input: unknown,
  ): Promise<{ organization_id: string; applied_revision: number }> {
    const deadline = new Date(Date.now() + 10000);
    const configuration = parseExecutionConfiguration(input);
    const beforeAck = this.dependencies.beforeAck;
    const beforePeerAck = this.dependencies.beforePeerAck;
    if (beforeAck === undefined && beforePeerAck === undefined)
      return this.authorized(configuration.organization_id, undefined, () =>
        this.applyCurrent(configuration),
      );
    const { applied, publication } = await this.authorized(
      configuration.organization_id,
      undefined,
      async () => {
        const applied = await this.applyCurrent(configuration);
        const publication = this.publications.get(applied.organization_id);
        if (
          publication === undefined ||
          publication.configuration.revision !== applied.applied_revision
        )
          throw new DomainError(
            "configuration_unavailable",
            "Execution configuration is unavailable",
          );
        return { applied, publication };
      },
    );
    // Owner proof may await Agent work. Release the publication boundary first
    // so healthy Agents and later configuration changes can continue.
    await beforeAck?.(publication.configuration);
    await beforePeerAck?.(publication, deadline);
    publication.assertCurrent();
    return applied;
  }

  /** Peer leaf: read the sealed publication, apply locally, and never aggregate or persist it. */
  public async applyPeerPublication(input: unknown): Promise<LocalExecutionPublication> {
    const expected = parseExecutionPublication(input);
    return this.authorized(expected.organization_id, undefined, async () => {
      const stored = await this.dependencies.repository.loadAuthority(expected.organization_id);
      if (stored === null || !isDeepStrictEqual(executionPublication(stored), expected))
        throw publicationUnavailable();
      // Own this capture: neither an adapter nor a later caller may mutate the
      // private payload that the final aggregate transaction must confirm.
      const authority = parseExecutionConfiguration(stored);
      if (!isDeepStrictEqual(executionPublication(authority), expected))
        throw publicationUnavailable();
      freezeAuthority(authority);
      this.dependencies.clients.validate(authority);
      const connections = this.dependencies.runtimeConnections.prepare(authority);
      try {
        await this.publish(authority, connections, async () => {
          const current = await this.dependencies.repository.loadAuthority(
            expected.organization_id,
          );
          if (!isDeepStrictEqual(current, authority)) throw publicationUnavailable();
        });
      } finally {
        connections.rollback();
      }
      const capture = this.publications.get(expected.organization_id);
      if (capture === undefined) throw publicationUnavailable();
      return capture;
    });
  }

  // Serialize local commits per Agent. A configuration publication waits for
  // every earlier Agent commit and blocks all later access in the organization.
  // Never hold this boundary for a model request, a Run, or user approval.
  public withAccess<T>(
    identity: ExecutionIdentity,
    action: (input: {
      agent: AgentConfiguration;
      configuration: PublicExecutionConfiguration;
    }) => Promise<T>,
  ): Promise<T> {
    return this.authorized(identity.organizationId, identity.agentId, () =>
      action(this.inspect(identity)),
    );
  }

  public inspect(identity: ExecutionIdentity): {
    agent: AgentConfiguration;
    configuration: PublicExecutionConfiguration;
  } {
    const configuration = this.configurations.get(identity.organizationId);
    if (configuration === undefined)
      throw new DomainError("configuration_not_ready", "Execution configuration is not ready");
    const agent = authorizeConfiguredAgent(configuration, identity);
    return { agent, configuration };
  }

  public subscribe(organizationId: string, changed: () => void): () => void {
    return this.changes.subscribe(organizationId, changed);
  }

  /** Run acceptance calls this inside withAccess, before its durable acceptance commit. */
  public retainRuntimeRun(runId: string, binding: RuntimeBinding): void {
    this.dependencies.runtimeConnections.retainRun(runId, binding);
  }

  public releaseRuntimeRun(runId: string): void {
    this.dependencies.runtimeConnections.releaseRun(runId);
  }

  /** Private reconciliation uses an already persisted Agent scope, including closed Agents. */
  public runtimeForCleanup(scope: {
    organizationId: string;
    agentId: string;
  }): RuntimeBinding | null {
    const configuration = this.configurations.get(scope.organizationId);
    const runtime =
      configuration === undefined
        ? undefined
        : findConfiguredAgent(configuration, scope.agentId)?.runtime;
    return runtime
      ? this.dependencies.runtimeConnections.findForCleanup({
          ...scope,
          revision: runtime.runtime_revision,
          executionId: runtime.runtime_execution_id,
          mcpEndpoint: runtime.mcp_endpoint,
          ...(runtime.connection_id === undefined ? {} : { connectionId: runtime.connection_id }),
        })
      : null;
  }

  public closedAgent(operation: ClosedAgentOperation): {
    agent: AgentConfiguration;
    revision: number;
  } {
    const configuration = this.configurations.get(operation.organizationId);
    // Lifecycle settlement must not act on a superseded operation while a
    // publication is pending. Ordinary readers can still use the last view.
    if (
      configuration === undefined ||
      this.pending.get(operation.organizationId)?.publication !== undefined
    ) {
      throw new DomainError("configuration_not_ready", "Execution configuration is not ready");
    }
    const agent = findConfiguredAgent(configuration, operation.agentId);
    if (
      configuration.revision < operation.minimumRevision ||
      agent === undefined ||
      agent.accepting_runs ||
      agent.operation_id !== operation.operationId
    ) {
      throw new DomainError("agent_operation_conflict", "Agent lifecycle operation changed");
    }
    return { agent: structuredClone(agent), revision: configuration.revision };
  }

  private async applyCurrent(incoming: ExecutionConfiguration) {
    const organizationId = incoming.organization_id;
    const current = await this.dependencies.repository.load(organizationId);
    const applied = this.configurations.get(organizationId);
    const next = publicExecutionConfiguration(incoming);
    if (current !== null && current.revision > next.revision) {
      if (applied?.revision !== current.revision) {
        throw new DomainError(
          "configuration_conflict",
          "A newer configuration is required to initialize execution",
        );
      }
      return { organization_id: organizationId, applied_revision: current.revision };
    }
    this.requireConsistentRevision(current, next);
    this.requireConsistentProviders(current, incoming);
    this.dependencies.clients.validate(incoming);
    const connections = this.dependencies.runtimeConnections.prepare(incoming);
    try {
      try {
        // Replay must validate the durable private identity, or fill an exact
        // legacy projection, before acknowledging an in-memory publication.
        const saved = await this.dependencies.repository.save(incoming, current?.revision ?? null);
        if (!saved)
          throw new DomainError(
            "configuration_conflict",
            "Execution configuration revision changed",
          );
      } catch (error) {
        // A failed receipt does not prove that the transaction rolled back.
        // Retain the old view only after confirming it is still authoritative.
        let confirmed: ExecutionConfiguration | null = null;
        try {
          confirmed = await this.dependencies.repository.loadAuthority(organizationId);
        } catch {
          // Unknown durable authority closes admission until a valid replay.
        }
        if (
          applied === undefined ||
          confirmed === null ||
          !isDeepStrictEqual(publicExecutionConfiguration(confirmed), applied)
        )
          this.withdraw(organizationId);
        throw error;
      }
      // Equal-revision replay still verifies private identity and sender files.
      if (
        applied?.revision === next.revision &&
        this.dependencies.beforeAck === undefined &&
        this.dependencies.beforePeerAck === undefined
      ) {
        connections.commit();
        return { organization_id: organizationId, applied_revision: next.revision };
      }
      await this.publish(incoming, connections);
    } finally {
      connections.rollback();
    }
    return { organization_id: organizationId, applied_revision: next.revision };
  }

  private async publish(
    incoming: ExecutionConfiguration,
    connections: PreparedRuntimeConnections,
    beforeCommit?: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const authority = parseExecutionConfiguration(incoming);
    freezeAuthority(authority);
    const next = freezeExecutionConfiguration(publicExecutionConfiguration(authority));
    const organizationId = incoming.organization_id;
    try {
      this.dependencies.clients.apply(incoming);
      await this.dependencies.onApplied(structuredClone(next));
      signal?.throwIfAborted();
      await beforeCommit?.();
      signal?.throwIfAborted();
      connections.commit();
      this.configurations.set(organizationId, next);
      const capture: LocalExecutionPublication = Object.freeze({
        configuration: next,
        authority,
        assertCurrent: () => {
          if (
            this.publications.get(organizationId) !== capture ||
            this.pending.get(organizationId)?.publication !== undefined
          )
            throw publicationUnavailable();
        },
      });
      this.publications.set(organizationId, capture);
      this.changes.invalidate(organizationId);
      this.dependencies.onPublished?.(organizationId);
    } catch (error) {
      this.withdraw(organizationId);
      throw error;
    }
  }

  private withdraw(organizationId: string): void {
    this.configurations.delete(organizationId);
    this.publications.delete(organizationId);
    this.dependencies.runtimeConnections.revokePublication(organizationId);
    try {
      this.dependencies.onUnavailable(organizationId);
    } finally {
      this.changes.invalidate(organizationId);
    }
  }

  private requireConsistentRevision(
    current: PublicExecutionConfiguration | null,
    next: PublicExecutionConfiguration,
  ): void {
    if (current?.revision !== next.revision) return;
    if (!isDeepStrictEqual(current, next)) {
      throw new DomainError(
        "configuration_conflict",
        "Execution configuration differs at the same revision",
      );
    }
  }

  private requireConsistentProviders(
    current: PublicExecutionConfiguration | null,
    incoming: ExecutionConfiguration,
  ): void {
    const previous = new Map(
      current?.providers.map((provider) => [provider.connection_id, provider]),
    );
    for (const provider of incoming.providers) {
      const before = previous.get(provider.connection_id);
      if (before === undefined) continue;
      requireSameProviderRouting(before, provider);
    }
  }

  private async authorized<T>(
    organizationId: string,
    agentId: string | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const pending = this.pending.get(organizationId) ?? {
      publication: undefined,
      agents: new Map<string, Promise<void>>(),
    };
    this.pending.set(organizationId, pending);
    // Capture only predecessors. Publish the new tail before the first await:
    // later access cannot pass a queued publication or become its dependency.
    const predecessors =
      agentId === undefined
        ? [pending.publication, ...pending.agents.values()]
        : [pending.publication, pending.agents.get(agentId)];
    const completion = Promise.withResolvers<void>();
    if (agentId === undefined) pending.publication = completion.promise;
    else pending.agents.set(agentId, completion.promise);
    await Promise.all(predecessors.filter((previous) => previous !== undefined));
    try {
      return await action();
    } finally {
      completion.resolve();
      if (agentId === undefined) {
        if (pending.publication === completion.promise) pending.publication = undefined;
      } else if (pending.agents.get(agentId) === completion.promise) {
        pending.agents.delete(agentId);
      }
      if (pending.publication === undefined && pending.agents.size === 0)
        this.pending.delete(organizationId);
    }
  }
}

function publicationUnavailable(): DomainError {
  return new DomainError("configuration_unavailable", "Execution publication changed");
}

function freezeAuthority(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeAuthority(child);
  Object.freeze(value);
}
