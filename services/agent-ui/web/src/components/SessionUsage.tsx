import { Gauge } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { formatSessionCost } from "../lib/usage";
import type { SessionUsage as Usage } from "../lib/types";

export function SessionUsage({
  usage,
  stale,
}: {
  usage?: Usage;
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!usage) setOpen(false);
  }, [usage]);
  if (!usage) return null;
  const percentage =
    usage.size > 0 ? Math.round((usage.used / usage.size) * 100) : null;
  const exact = `${usage.used.toLocaleString("en-US")} / ${usage.size.toLocaleString("en-US")}`;
  const label = `Context usage: ${percentage == null ? "capacity not reported" : `${percentage}%`}, ${exact} tokens${stale ? ", last received" : ""}`;

  return (
    <div className="session-usage" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`usage-trigger ${percentage != null && percentage >= 80 ? "usage-high" : ""} ${stale ? "usage-stale" : ""}`}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Gauge size={16} aria-hidden="true" />
        <span>
          {percentage == null
            ? "?"
            : percentage > 100
              ? "100%+"
              : `${percentage}%`}
        </span>
      </button>
      {open ? (
        <div
          id={id}
          className="usage-popover"
          role="group"
          aria-label="Session usage"
        >
          <header>
            <strong>Session usage</strong>
            {stale ? <span className="usage-stale">Last received</span> : null}
          </header>
          <div
            className="usage-metric"
            title="Tokens currently in context, not lifetime token consumption"
          >
            <span>Context</span>
            <strong>{exact}</strong>
          </div>
          {percentage != null ? (
            <meter
              min={0}
              max={100}
              value={Math.min(100, Math.max(0, percentage))}
              aria-label="Context capacity"
            />
          ) : null}
          <div
            className="usage-metric"
            title={
              usage.cost
                ? `${usage.cost.currency} ${usage.cost.amount}`
                : "No cost has been reported for this session"
            }
          >
            <span>Known cost</span>
            <strong>{formatSessionCost(usage.cost)}</strong>
          </div>
          <span
            className="usage-note"
            title="Reported session costs may be incomplete. This is not a billing statement."
          >
            May be incomplete
          </span>
        </div>
      ) : null}
    </div>
  );
}
