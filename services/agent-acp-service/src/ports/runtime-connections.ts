import type { ExecutionConfiguration } from "../domain/execution-configuration.js";
import type { RuntimeBinding } from "../domain/types.js";

export interface PreparedRuntimeConnections {
  commit(): void;
  rollback(): void;
}

export type RuntimeCleanupFence = {
  organizationId: string;
  agentId: string;
  revision: string;
  executionId: string;
  mcpEndpoint: string;
  connectionId?: string;
};

/** Private publication and accepted-operation authority; never a public credential projection. */
export interface RuntimeConnectionAuthority {
  prepare(configuration: ExecutionConfiguration): PreparedRuntimeConnections;
  revokePublication(organizationId: string): void;
  findForCleanup(fence: RuntimeCleanupFence): RuntimeBinding | null;
  retainRun(runId: string, binding: RuntimeBinding): void;
  releaseRun(runId: string): void;
  retainOperation(operationId: string, binding: RuntimeBinding, options?: { cleanup: true }): void;
  releaseOperation(operationId: string): void;
  fetchFor(binding: RuntimeBinding): typeof fetch;
}
