import { Bot, Check, ChevronDown, LayoutGrid } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AgentSummary } from "../lib/types";
import { AgentManagementStatus } from "./AgentManagementStatus";
import { AgentPresence } from "./AgentPresence";

export function WorkspaceSwitcher({
  agents,
  activeAgent,
  compact,
  disabled,
  onSelect,
  onBrowse,
}: {
  agents: AgentSummary[];
  activeAgent: AgentSummary | undefined;
  compact: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onBrowse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const current = root.current?.querySelector<HTMLButtonElement>(
      '.workspace-option[aria-current="true"]',
    );
    const first = root.current?.querySelector<HTMLButtonElement>(
      ".workspace-option:not(:disabled)",
    );
    (current ?? first)?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  return (
    <div
      className="workspace-context"
      data-compact={compact}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        className={
          compact ? "workspace-switcher icon-button" : "workspace-switcher"
        }
        ref={trigger}
        type="button"
        aria-label={`Switch workspace: ${activeAgent?.name ?? "none"}`}
        title={
          compact ? `Workspace: ${activeAgent?.name ?? "none"}` : undefined
        }
        aria-current="true"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        {compact ? (
          <Bot size={18} aria-hidden="true" />
        ) : (
          <>
            <span className="workspace-title" title={activeAgent?.name}>
              {activeAgent?.name ?? "Choose a workspace"}
            </span>
            <ChevronDown size={15} aria-hidden="true" />
          </>
        )}
      </button>
      {open ? (
        <div
          className="workspace-popover"
          id={listId}
          role="group"
          aria-label="Workspaces"
        >
          <p className="workspace-popover-label">Switch workspace</p>
          <div className="workspace-options">
            {agents.map((agent) => {
              const current = agent.id === activeAgent?.id;
              return (
                <button
                  className={`workspace-option ${current ? "active" : ""}`}
                  key={agent.id}
                  type="button"
                  aria-current={current ? "true" : undefined}
                  disabled={disabled && !current}
                  onClick={() => {
                    close();
                    if (!current) onSelect(agent.id);
                  }}
                >
                  <span className="workspace-icon">
                    <Bot size={15} aria-hidden="true" />
                  </span>
                  <span className="workspace-copy">
                    <strong>{agent.name}</strong>
                    {current ? (
                      <AgentPresence status={agent.status} />
                    ) : (
                      <AgentManagementStatus state={agent.managementState} />
                    )}
                  </span>
                  {current ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          <button
            className="browse-workspaces"
            type="button"
            onClick={() => {
              close();
              onBrowse();
            }}
          >
            <LayoutGrid size={15} aria-hidden="true" /> All workspaces
          </button>
        </div>
      ) : null}
    </div>
  );
}
