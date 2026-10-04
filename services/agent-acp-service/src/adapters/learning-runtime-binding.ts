import type { AgentConfiguration, ExecutionIdentity } from "../domain/execution-configuration.js";
import { DomainError } from "../domain/errors.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { LearningScanScope } from "../domain/learning-scan.js";
import type { RuntimeBinding } from "../domain/types.js";

type Directory = {
  inspect(identity: ExecutionIdentity): {
    agent: Pick<AgentConfiguration, "runtime" | "accepting_runs">;
  };
  runtimeForCleanup(scope: { organizationId: string; agentId: string }): RuntimeBinding | null;
};

export class DirectoryLearningRuntimeBinding {
  public constructor(private readonly directory: Directory) {}

  public current(
    claim: LearningTaskClaim,
  ): Promise<(RuntimeBinding & { acceptingRuns: boolean }) | null> {
    return this.currentScope({
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    });
  }

  /** Accepted effect recovery borrows installed authority, never closed-publication metadata. */
  public forCleanup(
    claim: LearningTaskClaim,
  ): Promise<(RuntimeBinding & { acceptingRuns: boolean }) | null> {
    return Promise.resolve().then(() => {
      const binding = this.directory.runtimeForCleanup({
        organizationId: claim.organizationId,
        agentId: claim.agentId,
      });
      if (binding === null) return null;
      let acceptingRuns = false;
      try {
        const { agent } = this.directory.inspect({
          organizationId: claim.organizationId,
          principalId: claim.ownerId,
          agentId: claim.agentId,
        });
        acceptingRuns =
          agent.accepting_runs &&
          agent.runtime?.runtime_revision === binding.revision &&
          agent.runtime.runtime_execution_id === binding.executionId &&
          agent.runtime.mcp_endpoint === binding.mcpEndpoint &&
          agent.runtime.connection_id === binding.connectionId;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "access_denied") throw error;
      }
      return { ...binding, acceptingRuns };
    });
  }

  public currentScope(
    scope: LearningScanScope,
  ): Promise<(RuntimeBinding & { acceptingRuns: boolean }) | null> {
    return Promise.resolve().then(() => {
      const { agent } = this.directory.inspect({
        organizationId: scope.organizationId,
        principalId: scope.ownerId,
        agentId: scope.agentId,
      });
      return agent.runtime === null || agent.runtime.connection_id === undefined
        ? null
        : {
            executionId: agent.runtime.runtime_execution_id,
            mcpEndpoint: agent.runtime.mcp_endpoint,
            revision: agent.runtime.runtime_revision,
            connectionId: agent.runtime.connection_id,
            acceptingRuns: agent.accepting_runs,
          };
    });
  }
}
