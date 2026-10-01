import { BookOpen, CornerDownLeft, Slash } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { WorkspaceCommand } from "../../server/src/protocol/available-commands.ts";

export function CommandMenu({ id, commands, activeIndex, emptyMessage, onActive, onSelect }: {
  id: string;
  commands: readonly WorkspaceCommand[];
  activeIndex: number;
  emptyMessage: string;
  onActive: (index: number) => void;
  onSelect: (command: WorkspaceCommand) => void;
}) {
  const active = useRef<HTMLButtonElement>(null);
  const selectedName = commands[activeIndex]?.name;
  useLayoutEffect(() => {
    active.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeIndex, selectedName]);
  return (
    <div className="composer-command-menu">
      <div className="command-menu-heading">
        <span><Slash size={13} aria-hidden="true" /> Commands</span>
        <span>{commands.length ? `${commands.length} available` : ""}</span>
      </div>
      <div id={id} role="listbox" aria-label="Available commands" className="command-menu-options">
        {commands.map((command, index) => (
          <button type="button" role="option" tabIndex={-1}
            key={command.name} id={`${id}-${index}`} aria-selected={index === activeIndex}
            ref={index === activeIndex ? active : undefined}
            className="command-menu-option"
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onActive(index)}
            onClick={() => onSelect(command)}>
            <span className="command-menu-icon" aria-hidden="true">{command.name.startsWith("skill:") ? <BookOpen size={16} /> : <Slash size={16} />}</span>
            <span className="command-menu-copy">
              <span className="command-menu-title"><strong>/{command.name}</strong>{command.name.startsWith("skill:system:") ? <small className="command-menu-kind">Preset Skill</small> : command.name.startsWith("skill:personal:") ? <small className="command-menu-kind">Personal Skill</small> : null}</span>
              <span>{command.description}</span>
              {command.input ? <small>{command.input.hint}</small> : null}
            </span>
            <CornerDownLeft size={14} className="command-menu-enter" aria-hidden="true" />
          </button>
        ))}
      </div>
      {!commands.length ? <div className="command-menu-empty" role="status">{emptyMessage}</div> : null}
      <div className="command-menu-footer" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span><kbd>Enter</kbd><kbd>Tab</kbd> Complete</span>
        <span><kbd>Esc</kbd> Close</span>
      </div>
    </div>
  );
}
