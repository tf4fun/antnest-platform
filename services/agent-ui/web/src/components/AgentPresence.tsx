import type { AgentStatus } from "../lib/types";

const labels: Record<AgentStatus, string> = {
  ready: "Available",
  busy: "Working",
  offline: "Offline",
  unknown: "Status unavailable",
};

export function AgentPresence({ status }: { status: AgentStatus }) {
  return (
    <span className={`presence presence-${status}`}>{labels[status]}</span>
  );
}
