import type { AgentManagementState } from "../lib/types";

type Presentation = { label: string; tone: string };

const runtimeLabels: Record<AgentManagementState["runtime"], Presentation> = {
  available: { label: "Available", tone: "ready" },
  waiting: { label: "Waiting for startup", tone: "busy" },
  unhealthy: { label: "Unhealthy", tone: "error" },
  exited: { label: "Stopped", tone: "error" },
  absent: { label: "Runtime missing", tone: "error" },
  unknown: { label: "Runtime status unknown", tone: "unknown" },
};

function presentation(state: AgentManagementState): Presentation {
  if (state.lifecycle === "not_created")
    return { label: "Not created", tone: "unknown" };
  if (state.lifecycle === "deleted")
    return { label: "Deleted", tone: "unknown" };
  if (state.activation === "disabled")
    return { label: "Disabled", tone: "unknown" };
  return runtimeLabels[state.runtime];
}

export function AgentManagementStatus({
  state,
}: {
  state: AgentManagementState;
}) {
  const { label, tone } = presentation(state);
  return <span className={`presence presence-${tone}`}>{label}</span>;
}
