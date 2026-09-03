import { Check, ChevronDown, CircleAlert, LoaderCircle, Terminal, type LucideIcon } from "lucide-react";
import type { ToolActivity as ToolActivityModel } from "../lib/types";

const statusIcon: Record<ToolActivityModel["status"], LucideIcon> = {
  completed: Check,
  failed: CircleAlert,
  running: LoaderCircle,
};

export function ToolActivity({ activity }: { activity: ToolActivityModel }) {
  const StatusIcon = statusIcon[activity.status];
  const duration = activity.durationMs === undefined ? "" : `${activity.durationMs} ms`;

  return (
    <details className={`tool-activity tool-${activity.status}`}>
      <summary>
        <span className="tool-kind" aria-hidden="true"><Terminal size={14} /></span>
        <span className="tool-title">
          <strong>{activity.label}</strong>
          <small>{activity.tool}</small>
        </span>
        <span className="tool-meta">
          {duration ? <span>{duration}</span> : null}
          <StatusIcon className={activity.status === "running" ? "spin" : ""} size={14} aria-hidden="true" />
          <ChevronDown className="tool-chevron" size={14} aria-hidden="true" />
        </span>
      </summary>
      <div className="tool-detail">
        <p>{activity.summary}</p>
        {activity.detail ? <code>{activity.detail}</code> : null}
      </div>
    </details>
  );
}
