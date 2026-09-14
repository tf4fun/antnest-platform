import { parseAgentSettlement, type AgentSettlementResult } from "../domain/agent-settlement.js";
import { DomainError } from "../domain/errors.js";
import type { AgentSettlementPort } from "../ports/agent-settlement.js";
import type { RuntimeProtectionRepository } from "../ports/execution-repository.js";
import type { ExecutionDirectory } from "./execution-directory.js";
import type { RunSupervisor } from "./run-supervisor.js";

type Dependencies = {
  directory: ExecutionDirectory;
  supervisor: Pick<RunSupervisor, "quiesceAgent" | "stopSignal">;
  protection: RuntimeProtectionRepository;
  now: () => Date;
};

export class AgentSettlement implements AgentSettlementPort {
  public constructor(private readonly dependencies: Dependencies) {}

  public async settle(input: unknown, signal?: AbortSignal): Promise<AgentSettlementResult> {
    const request = parseAgentSettlement(input);
    const operation = {
      organizationId: request.organization_id,
      agentId: request.agent_id,
      minimumRevision: request.minimum_revision,
      operationId: request.operation_id,
    };
    const deadline = Date.parse(request.deadline_at);
    const waiting = new AbortController();
    const stopped = this.dependencies.supervisor.stopSignal;
    stopped.throwIfAborted();
    const stopWaiting = AbortSignal.any([
      waiting.signal,
      stopped,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const expired = () => stopWaiting.aborted || this.dependencies.now().getTime() >= deadline;
    const remaining = Math.max(
      0,
      Math.min(deadline - this.dependencies.now().getTime(), 2_147_483_647),
    );
    const timer = setTimeout(() => waiting.abort(), remaining);
    timer.unref();
    try {
      // Inspect and initiate cancellation in one synchronous turn. Neither
      // evidence reads nor waiting belongs inside the configuration commit queue.
      this.dependencies.directory.closedAgent(operation);
      if (expired()) waiting.abort();
      const quiescent = await this.dependencies.supervisor.quiesceAgent(
        operation,
        request.mode,
        stopWaiting,
      );
      stopped.throwIfAborted();
      const current = this.dependencies.directory.closedAgent(operation);
      if (!quiescent || expired())
        return { applied_revision: current.revision, outcome: "not_settled" };
      const runtimeRevision = current.agent.runtime?.runtime_revision ?? null;
      let protectedRuntime: boolean;
      try {
        protectedRuntime = await this.dependencies.protection.hasUnstoppedRuntimeCalls(
          {
            organizationId: operation.organizationId,
            agentId: operation.agentId,
            runtimeRevision,
          },
          stopWaiting,
        );
      } catch (error) {
        stopped.throwIfAborted();
        if (!stopWaiting.aborted) throw error;
        return {
          applied_revision: this.dependencies.directory.closedAgent(operation).revision,
          outcome: "not_settled",
        };
      }
      stopped.throwIfAborted();
      const latest = this.dependencies.directory.closedAgent(operation);
      if ((latest.agent.runtime?.runtime_revision ?? null) !== runtimeRevision)
        throw new DomainError("agent_operation_conflict", "Runtime changed during settlement");
      return {
        applied_revision: latest.revision,
        outcome: expired()
          ? "not_settled"
          : protectedRuntime
            ? "runtime_barrier_required"
            : "settled",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
