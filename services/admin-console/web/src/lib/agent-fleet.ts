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

const convergedLifecycleByDesiredState: Record<string, string> = {
  enabled: "available",
  disabled: "disabled",
  deleted: "deleted",
};

const eventLabels: Record<string, string> = {
  agent_create_requested: "Creation requested",
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
};

export function agentsForView(agents: Agent[], view: AgentFleetView): Agent[] {
  return agents.filter((agent) =>
    view === "deleted"
      ? agent.desired_state === "deleted"
      : agent.desired_state !== "deleted",
  );
}

export function agentOwnerView(members: DirectoryMember[]): AgentOwnerView {
  return {
    selectable: members.filter(({ user, membership }) => user.active && membership.active),
    byUserID: new Map(members.map((member) => [member.user.id, member])),
  };
}

export function agentStatusPresentation(agent: Agent): AgentStatusPresentation {
  const convergedLifecycle = convergedLifecycleByDesiredState[agent.desired_state];
  if (convergedLifecycle === agent.lifecycle_state) {
    return { lifecycle: agent.lifecycle_state };
  }
  return {
    lifecycle: agent.lifecycle_state,
    target: humanize(agent.desired_state),
  };
}

export function agentEventLabel(eventType: string): string {
  return eventLabels[eventType] ?? humanize(eventType);
}

export function agentActionAvailability(
  agent: Agent,
  operationRunning: boolean,
): AgentActionAvailability {
  const retained = agent.lifecycle_state === "deleted";
  const deletionStarted = agent.desired_state === "deleted";
  if (retained || deletionStarted || operationRunning || agent.active_operation_request_id) {
    return {
      retained,
      canRebuild: false,
      canEnable: false,
      canDisable: false,
      canDelete: false,
    };
  }

  const available = agent.desired_state === "enabled" && agent.lifecycle_state === "available";
  const disabled = agent.desired_state === "disabled" && agent.lifecycle_state === "disabled";
  return {
    retained: false,
    canRebuild: available,
    canEnable: disabled,
    canDisable: available,
    canDelete: available || disabled,
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
  return operation?.state === "running" ? undefined : operation;
}

function humanize(value: string): string {
  const words = value.trim().replaceAll("_", " ");
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Unknown";
}
