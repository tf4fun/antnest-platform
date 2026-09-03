import { resourceFailure, type ResourceFailure } from "./resource-failure.ts";

export type AgentDetailResource =
  | "agent_state"
  | "owner_profile"
  | "operation_progress"
  | "lifecycle_events";

export type AgentEventRecoveryDecision =
  | { action: "retry"; delayMs: number }
  | { action: "stop" };

const failurePrefix: Record<AgentDetailResource, string> = {
  agent_state: "Agent state could not be refreshed",
  owner_profile: "Owner profile could not be loaded",
  operation_progress: "Operation progress could not be loaded",
  lifecycle_events: "Lifecycle events could not be loaded",
};

export function agentDetailFailure(
  resource: AgentDetailResource,
  cause: unknown,
): ResourceFailure {
  const failure = resourceFailure(cause);
  return {
    ...failure,
    message: `${failurePrefix[resource]}: ${failure.message}`,
  };
}

export function agentEventRecoveryDecision(
  failure: ResourceFailure,
): AgentEventRecoveryDecision {
  return failure.retryable
    ? { action: "retry", delayMs: 1000 }
    : { action: "stop" };
}
