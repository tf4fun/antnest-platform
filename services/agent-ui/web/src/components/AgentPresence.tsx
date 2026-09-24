import type { AgentStatus } from "../lib/types";

const labels: Record<AgentStatus, string> = {
  ready: "Available",
  busy: "Working",
  offline: "Offline",
  unknown: "Status unavailable",
};

export function AgentPresence({
  status,
  announce = false,
}: {
  status: AgentStatus;
  announce?: boolean;
}) {
  return (
    <span
      className={`presence presence-${status}`}
      role={announce ? "status" : undefined}
    >
      {labels[status]}
    </span>
  );
}
