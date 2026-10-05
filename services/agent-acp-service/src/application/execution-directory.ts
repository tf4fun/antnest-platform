import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../domain/errors.js";
import {
  authorizeConfiguredAgent,
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  requireSameProviderRouting,
  type AgentConfiguration,
  type ExecutionConfiguration,
  type ExecutionIdentity,
  type PublicExecutionConfiguration,
} from "../domain/execution-configuration.js";
import type { ExecutionConfigurationRepository } from "../ports/execution-configuration.js";
import type { RuntimeConnectionAuthority } from "../ports/runtime-connections.js";
import type { RuntimeBinding } from "../domain/types.js";
import type { ProviderClients } from "./provider-clients.js";
import { InvalidationListeners } from "./invalidation-listeners.js";

export type ExecutionDirectoryDependencies = {
  repository: ExecutionConfigurationRepository;
  clients: ProviderClients;
  runtimeConnections: RuntimeConnectionAuthority;
  onApplied: (configuration: PublicExecutionConfiguration) => Promise<void>;
  onUnavailable: (organizationId: string) => void;
  onPublished?: (organizationId: string) => void;
};

export type ClosedAgentOperation = {
  organizationId: string;
  agentId: string;
  minimumRevision: number;
  operationId: string;
};

export class ExecutionDirectory {
  private readonly configurations = new Map<string, PublicExecutionConfiguration>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly changes = new InvalidationListeners();

  public constructor(private readonly dependencies: ExecutionDirectoryDependencies) {}

  public async apply(
    input: unknown,
  ): Promise<{ organization_id: string; applied_revision: number }> {
    const configuration = parseExecutionConfiguration(input);
    return this.exclusive(configuration.organization_id, () => this.applyCurrent(configuration));
  }

  // Keep only short local commits/publications inside this authority boundary,
  // never a model request, a complete Run, or a wait for user approval.
  public withAccess<T>(
    identity: ExecutionIdentity,
    action: (input: {
      agent: AgentConfiguration;
      configuration: PublicExecutionConfiguration;
    }) => Promise<T>,
  ): Promise<T> {
    return this.exclusive(identity.organizationId, () => action(this.inspect(identity)));
  }

  public inspect(identity: ExecutionIdentity): {
    agent: AgentConfiguration;
    configuration: PublicExecutionConfiguration;
  } {
    const configuration = this.configurations.get(identity.organizationId);
    if (configuration === undefined)
      throw new DomainError("configuration_not_ready", "Execution configuration is not ready");
    const agent = authorizeConfiguredAgent(configuration, identity);
    return structuredClone({ agent, configuration });
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
    const runtime = this.configurations
      .get(scope.organizationId)
      ?.agents.find((agent) => agent.agent_id === scope.agentId)?.runtime;
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
    if (configuration === undefined) {
      throw new DomainError("configuration_not_ready", "Execution configuration is not ready");
    }
    const agent = configuration.agents.find((item) => item.agent_id === operation.agentId);
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
      // Equal-revision replay still verifies private identity and sender files.
      if (applied?.revision === next.revision) {
        connections.commit();
        return { organization_id: organizationId, applied_revision: next.revision };
      }
      if (current?.revision !== next.revision) {
        const saved = await this.dependencies.repository.save(next, current?.revision ?? null);
        if (!saved)
          throw new DomainError(
            "configuration_conflict",
            "Execution configuration revision changed",
          );
      }
      this.configurations.delete(organizationId);
      try {
        this.dependencies.clients.apply(incoming);
        await this.dependencies.onApplied(structuredClone(next));
        connections.commit();
        this.configurations.set(organizationId, next);
        this.changes.invalidate(organizationId);
        this.dependencies.onPublished?.(organizationId);
      } catch (error) {
        this.configurations.delete(organizationId);
        this.dependencies.runtimeConnections.revokePublication(organizationId);
        try {
          this.dependencies.onUnavailable(organizationId);
        } finally {
          this.changes.invalidate(organizationId);
        }
        throw error;
      }
    } finally {
      connections.rollback();
    }
    return { organization_id: organizationId, applied_revision: next.revision };
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

  private async exclusive<T>(organizationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(organizationId);
    const completion = Promise.withResolvers<void>();
    this.pending.set(organizationId, completion.promise);
    await previous;
    try {
      return await action();
    } finally {
      completion.resolve();
      if (this.pending.get(organizationId) === completion.promise)
        this.pending.delete(organizationId);
    }
  }
}
