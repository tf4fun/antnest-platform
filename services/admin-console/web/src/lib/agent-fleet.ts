import type { Agent, AgentEvent, DirectoryMember, LifecycleOperation } from "./types";

export type AgentFleetView = "current" | "deleted";

export type AgentActionAvailability = {
  retained: boolean;
  canRebuild: boolean;
  canEnable: boolean;
  canDisable: boolean;
  canDelete: boolean;
};

export type AgentStatusPresentation = {
  lifecycle: string;
  target?: string;
};

export type AgentOwnerView = {
  selectable: DirectoryMember[];
  byUserID: Map<string, DirectoryMember>;
};

const eventLabels: Record<string, string> = {
  agent_create_requested: "Creation requested",
  agent_created: "Creation completed",
  agent_runtime_condition_changed: "Runtime status changed",
  agent_ready: "Agent available",
  agent_build_failed: "Build failed",
  agent_rebuild_requested: "Rebuild requested",
  agent_rebuilt: "Rebuild completed",
  agent_disable_requested: "Disable requested",
  agent_disabled: "Agent disabled",
  agent_disable_failed: "Disable failed",
  agent_enable_requested: "Enable requested",
  agent_enabled: "Agent enabled",
  agent_enable_failed: "Enable failed",
  agent_delete_requested: "Deletion requested",
  agent_deleted: "Agent deleted",
  agent_lifecycle_quarantined: "Lifecycle quarantined",
  agent_runtime_restarted: "Runtime restarted",
  agent_runtime_missing: "Runtime missing",
};

export function agentsForView(agents: Agent[], view: AgentFleetView): Agent[] {
  return agents.filter((agent) =>
    view === "deleted"
      ? agent.lifecycle_state === "deleted"
      : agent.lifecycle_state !== "deleted",
  );
}

export function agentOwnerView(members: DirectoryMember[]): AgentOwnerView {
  return {
    selectable: members.filter(({ user, membership }) => user.active && membership.active),
    byUserID: new Map(members.map((member) => [member.user.id, member])),
  };
}

export function agentStatusPresentation(agent: Agent): AgentStatusPresentation {
  const lifecycle = agentDisplayState(agent);
  const confirmed = agent.lifecycle_state === "deleted" ? "deleted" : agent.activation_state;
  if (confirmed === agent.desired_state) return { lifecycle };
  return {
    lifecycle,
    target: humanize(agent.desired_state),
  };
}

function agentDisplayState(agent: Agent): string {
  if (agent.lifecycle_state !== "created") return agent.lifecycle_state;
  if (agent.activation_state === "disabled") return "disabled";
  if (agent.runtime_state === "available" && !agent.executable_execution_revision) return "not_executable";
  return agent.runtime_state;
}

export function agentFleetCounts(agents: Agent[]) {
  const counts = { available: 0, disabled: 0, attention: 0, pending: 0 };
  for (const agent of agentsForView(agents, "current")) {
    if (agent.active_operation_request_id) counts.pending++;
    else if (agent.activation_state === "disabled") counts.disabled++;
    else if (agent.desired_state === "enabled" && agentDisplayState(agent) === "available") counts.available++;
    else if (agent.failure_code || ["unhealthy", "exited", "absent", "not_executable"].includes(agentDisplayState(agent))) counts.attention++;
    else counts.pending++;
  }
  return counts;
}

export function agentEventLabel(eventType: string): string {
  return eventLabels[eventType] ?? humanize(eventType);
}

export function agentRecoveryAvailable(agent: Agent): boolean {
  return agent.desired_state === "enabled" && agent.lifecycle_state === "created" && agent.activation_state === "enabled" &&
    Boolean(agent.agent_spec_revision && agent.runtime?.runtime_revision) &&
    !agent.executable_execution_revision &&
    agent.failure_code !== "lifecycle_invariant_failed";
}

export function agentFailureMessage(agent: Agent): string {
  const observedFailures: Record<string, string> = {
    runtime_missing: "The runtime is missing; this Agent no longer has an active execution environment.",
    runtime_deleted: "The runtime is missing; its container was removed outside the Agent lifecycle.",
    runtime_restarted: "The runtime restarted; the previous execution environment is no longer active.",
  };
  const reason = observedFailures[agent.failure_code ?? ""];
  if (reason) return `${reason} Code: ${agent.failure_code}.`;
  return `The latest lifecycle change failed${agent.failure_stage ? ` during ${agent.failure_stage.replaceAll("_", " ")}` : ""}: ${agent.failure_code}. Review the retained lifecycle history below.`;
}

export function agentActionAvailability(
  agent: Agent,
  operationRunning: boolean,
): AgentActionAvailability {
  const retained = agent.lifecycle_state === "deleted";
  if (retained || operationRunning || agent.active_operation_request_id) {
    return {
      retained,
      canRebuild: false,
      canEnable: false,
      canDisable: false,
      canDelete: false,
    };
  }

  const created = agent.lifecycle_state === "created";
  const configured = created && Boolean(agent.agent_spec_revision && agent.runtime?.runtime_revision) && agent.failure_code !== "lifecycle_invariant_failed";
  const enabled = configured && agent.activation_state === "enabled";
  const disabled = configured && agent.desired_state === "disabled" && agent.activation_state === "disabled";
  return {
    retained: false,
    canRebuild: enabled && agent.desired_state === "enabled",
    canEnable: disabled,
    canDisable: enabled && agent.desired_state !== "deleted",
    canDelete: created || agent.lifecycle_state === "not_created",
  };
}

export function latestOperationRequestID(events: AgentEvent[]): string | undefined {
  let latestSequence = -1;
  let requestID: string | undefined;
  for (const event of events) {
    if (event.operation_request_id && event.global_sequence >= latestSequence) {
      latestSequence = event.global_sequence;
      requestID = event.operation_request_id;
    }
  }
  return requestID;
}

export function recoveryOperationRequestID(
  agent: Agent | undefined,
  replayedEvents: AgentEvent[],
): string | undefined {
  return agent?.active_operation_request_id ?? latestOperationRequestID(replayedEvents);
}

export function selectAgentSnapshot(current: Agent | undefined, incoming: Agent): Agent {
  if (
    current?.agent_id === incoming.agent_id &&
    incoming.aggregate_sequence < current.aggregate_sequence
  ) {
    return current;
  }
  return incoming;
}

export function mergeAgentEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  const known = new Set(current.map((event) => event.event_id));
  return [
    ...current,
    ...incoming.filter((event) => !known.has(event.event_id)),
  ];
}

export function reconcileAgentOperation(
  activeRequestID: string | undefined,
  operation: LifecycleOperation | undefined,
): LifecycleOperation | undefined {
  if (activeRequestID) {
    return operation?.request_id === activeRequestID ? operation : undefined;
  }
  return operation;
}

export function selectOperationSnapshot(
  current: LifecycleOperation | undefined,
  incoming: LifecycleOperation,
): LifecycleOperation {
  if (current?.request_id === incoming.request_id && current.state !== "running") {
    return current;
  }
  return incoming;
}

function humanize(value: string): string {
  const words = value.trim().replaceAll("_", " ");
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Unknown";
}
