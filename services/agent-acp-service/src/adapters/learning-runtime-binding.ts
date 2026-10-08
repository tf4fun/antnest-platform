import type { AgentConfiguration, ExecutionIdentity } from "../domain/execution-configuration.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { LearningScanScope } from "../domain/learning-scan.js";
import type { RuntimeBinding } from "../domain/types.js";

type Directory = {
  inspect(identity: ExecutionIdentity): {
    agent: Pick<AgentConfiguration, "runtime" | "accepting_runs">;
  };
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
