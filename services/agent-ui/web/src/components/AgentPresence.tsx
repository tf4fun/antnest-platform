import type { AgentStatus } from "../lib/types";

const labels: Record<AgentStatus, string> = {
  ready: "Available",
  busy: "Working",
  offline: "Offline",
  unknown: "Status unavailable",
};

export function AgentPresence({
  status,
  preparing = false,
  announce = false,
}: {
  status: AgentStatus;
  preparing?: boolean;
  announce?: boolean;
}) {
  return (
    <span
      className={`presence presence-${status}`}
      role={announce ? "status" : undefined}
    >
      {status === "offline" && preparing ? "Preparing" : labels[status]}
    </span>
  );
}
