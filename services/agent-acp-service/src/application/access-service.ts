import { DomainError } from "../domain/errors.js";
import type { ConnectionBinding } from "../domain/types.js";
import type { AgentControllerPort, ResolveAgentAccessResult } from "../ports/agent-controller.js";

export type AccessServiceDependencies = {
  agentController: Pick<AgentControllerPort, "resolveAgentAccess">;
  id: () => string;
};

export class AccessService {
  public constructor(private readonly dependencies: AccessServiceDependencies) {}

  public async assert(binding: ConnectionBinding): Promise<void> {
    const current = await this.dependencies.agentController.resolveAgentAccess({
      requestId: this.dependencies.id(),
      agentAccessSubject: binding.agentAccessSubject,
    });
    if (!matchesBinding(current, binding)) {
      throw new DomainError(
        "connection_binding_stale",
        "Agent access changed; reconnect before issuing another request",
      );
    }
  }
}

function matchesBinding(current: ResolveAgentAccessResult, binding: ConnectionBinding): boolean {
  return (
    current.principalId === binding.principalId &&
    current.agentId === binding.agentId &&
    current.accessRevision === binding.accessRevision
  );
}
