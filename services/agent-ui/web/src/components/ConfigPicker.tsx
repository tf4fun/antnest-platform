import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  Brain,
  Check,
  ChevronDown,
  Cpu,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

export function ConfigPicker({
  option,
  disabled,
  onChange,
}: {
  option: SelectOption;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({
    left: 0,
    bottom: 0,
    maxHeight: 400,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const groups = option.options.map((item) =>
    "options" in item
      ? { name: item.name, id: item.group, choices: item.options }
      : { name: "", id: item.value, choices: [item] },
  );
  const choices = groups.flatMap((group) => group.choices);
  const current = choices.find(
    (choice) => choice.value === option.currentValue,
  );
  const searchable = option.category === "model" || choices.length >= 8;
  const normalized = query.trim().toLocaleLowerCase();
  const visible = groups
    .map((group) => ({
      ...group,
      choices: group.choices.filter((choice) =>
        `${group.name} ${choice.name} ${choice.value} ${choice.description ?? ""}`
          .toLocaleLowerCase()
          .includes(normalized),
      ),
    }))
    .filter((group) => group.choices.length);
  const Icon =
    option.category === "model"
      ? Cpu
      : option.category === "thought_level"
        ? Brain
        : option.category === "mode"
          ? ShieldCheck
          : SlidersHorizontal;
  const expanded = open && !disabled;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function toggle() {
    setQuery("");
    setOpen((value) => !value);
  }

  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(328, window.innerWidth - 24);
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        bottom: window.innerHeight - rect.top + 8,
        maxHeight: Math.max(80, rect.top - 20),
      });
    };
    place();
    if (searchable) search.current?.focus();
    else {
      const selected = popup.current?.querySelector<HTMLButtonElement>(
        '[aria-selected="true"]',
      );
      const first =
        popup.current?.querySelector<HTMLButtonElement>('[role="option"]');
      (selected ?? first)?.focus();
    }
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [expanded, searchable]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [expanded]);

  function navigate(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (event.target === search.current && ["Home", "End"].includes(event.key))
      return;
    event.preventDefault();
    const items = Array.from(
      popup.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % items.length
            : (index <= 0 ? items.length : index) - 1;
    items[next]?.focus();
  }

  return (
    <>
      <button
        ref={trigger}
        className="config-trigger"
        type="button"
        role="combobox"
        aria-label={option.name}
        aria-haspopup="listbox"
        aria-controls={expanded ? listId : undefined}
        aria-expanded={expanded}
        disabled={disabled}
        title={`${option.name}: ${current?.name ?? option.currentValue}`}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setQuery("");
            setOpen(true);
          } else if (event.key === "Escape") close();
        }}
      >
        <Icon size={14} aria-hidden="true" />
        <strong>{current?.name ?? option.currentValue}</strong>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {expanded
        ? createPortal(
            <div
              ref={popup}
              className="config-popover"
              style={position}
              onKeyDown={navigate}
            >
              <div className="config-heading">{option.name}</div>
              {searchable ? (
                <label className="config-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    ref={search}
                    type="search"
                    aria-label={`Search ${option.name}`}
                    placeholder={`Search ${option.name.toLowerCase()}`}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              ) : null}
              <div
                id={listId}
                role="listbox"
                aria-label={option.name}
                className="config-options"
              >
                {visible.map((group) => (
                  <div
                    key={group.id}
                    role={group.name ? "group" : undefined}
                    aria-label={group.name || undefined}
                  >
                    {group.name ? (
                      <div className="config-group-name">{group.name}</div>
                    ) : null}
                    {group.choices.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        role="option"
                        aria-selected={choice.value === option.currentValue}
                        onClick={() => {
                          close(true);
                          if (choice.value !== option.currentValue)
                            onChange(choice.value);
                        }}
                      >
                        <span>
                          <strong>{choice.name}</strong>
                          {choice.description ? (
                            <small>{choice.description}</small>
                          ) : null}
                        </span>
                        {choice.value === option.currentValue ? (
                          <Check size={15} aria-hidden="true" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ))}
                {!visible.length ? <p>No matching options</p> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
