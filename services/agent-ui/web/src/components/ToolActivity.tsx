import {
  Check,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  FileSearch,
  LoaderCircle,
  TerminalSquare,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ToolActivity as ToolActivityModel } from "../lib/types";
import { useId } from "react";
import { CopyButton } from "./CopyButton";

const kindIcon: Record<string, LucideIcon> = {
  read: FileSearch,
  search: FileSearch,
  edit: FilePenLine,
  write: FilePenLine,
  bash: TerminalSquare,
  execute: TerminalSquare,
};

const statusIcon: Record<ToolActivityModel["status"], LucideIcon> = {
  completed: Check,
  failed: CircleAlert,
  running: LoaderCircle,
};

export function ToolActivity({
  activity,
  onDisclosure,
}: {
  activity: ToolActivityModel;
  onDisclosure?: () => void;
}) {
  const StatusIcon = statusIcon[activity.status];
  const Icon = kindIcon[activity.tool] ?? Wrench;
  const duration =
    activity.durationMs === undefined ? "" : `${activity.durationMs} ms`;
  const output =
    activity.output ||
    (activity.detail !== activity.input ? activity.detail : undefined);

  return (
    <details className={`tool-activity tool-${activity.status}`}>
      <summary onClick={onDisclosure}>
        <span className="tool-kind" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="tool-title">
          <strong title={activity.label}>{activity.label}</strong>
          {activity.tool !== "tool" && activity.tool !== activity.label ? (
            <small>{activity.tool}</small>
          ) : null}
        </span>
        <span className="tool-meta">
          {duration ? <span>{duration}</span> : null}
          <span className="tool-status" title={activity.summary}>
            <StatusIcon
              className={activity.status === "running" ? "spin" : ""}
              size={14}
              aria-hidden="true"
            />
            <span>{activity.summary}</span>
          </span>
        </span>
        <ChevronRight
          className="disclosure-chevron"
          size={14}
          aria-hidden="true"
        />
      </summary>
      <div className="tool-detail">
        {activity.input ? (
          <ToolPayload label="Input" text={activity.input} />
        ) : null}
        {output ? (
          <ToolPayload label="Output" text={output} />
        ) : (
          <p className="tool-empty">
            {activity.status === "running"
              ? "Waiting for output"
              : "No output received"}
          </p>
        )}
      </div>
    </details>
  );
}

function ToolPayload({ label, text }: { label: string; text: string }) {
  const id = useId();
  return (
    <section className="tool-payload" aria-labelledby={id}>
      <header>
        <h4 id={id}>{label}</h4>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </header>
      <pre tabIndex={0} aria-label={`${label} contents`}>
        <code>{text}</code>
      </pre>
    </section>
  );
}
