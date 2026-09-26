import {
  ArrowUp,
  Paperclip,
  FileText,
  Image as ImageIcon,
  AudioLines,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Square,
  X,
} from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from "react";
import type { AgentStatus, Attachment } from "../lib/types";
import { canSubmit } from "../lib/presentation";
import { CommandMenu } from "./CommandMenu";
import type { WorkspaceCommand } from "../../server/src/protocol/available-commands.ts";

type Props = {
  rootRef?: Ref<HTMLDivElement>;
  commands?: readonly WorkspaceCommand[];
  commandScope?: string;
  allowControlInput?: boolean;
  controlInput?: boolean;
  controlEnabled?: boolean;
  commanding?: boolean;
  feedback?: ReactNode;
  sessionControls?: ReactNode;
  usage?: ReactNode;
  fileAccept: string;
  configuring: boolean;
  preparing?: boolean;
  historyReady: boolean;
  draftMode?: boolean;
  sendBlocked?: boolean;
  openingHistory?: boolean;
  openingFailure?: boolean;
  value: string;
  attachments: Attachment[];
  agentStatus: AgentStatus;
  connected: boolean;
  sending: boolean;
  cancelling: boolean;
  cancellable: boolean;
  onChange: (value: string) => void;
  onFiles: (files: FileList) => void;
  onRemoveAttachment: (id: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

function statusCopy(
  agentStatus: AgentStatus,
  connected: boolean,
  sending: boolean,
): string {
  if (!connected) return "Connection unavailable";
  if (agentStatus === "unknown") return "Synchronizing Agent status";
  if (agentStatus === "offline") return "Agent is offline";
  if (sending) return "Agent is working";
  if (agentStatus === "busy") return "Agent is finishing another operation";
  return "";
}

export function Composer(props: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editorFocused, setEditorFocused] = useState(false);
  const [dismissedCommandKey, setDismissedCommandKey] = useState<string | null>(null);
  const [activeCommand, setActiveCommand] = useState({ key: "", index: 0 });
  const commandMenuId = useId();
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const restoreEditorFocus = useRef(false);
  const pendingRemovalFocus = useRef<{ id: string; index: number } | null>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  useLayoutEffect(() => {
    if (!textarea.current) return;
    if (expanded) {
      textarea.current.style.height = "";
      return;
    }
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(200, Math.max(72, textarea.current.scrollHeight))}px`;
  }, [props.value, expanded]);
  const disabled =
    !props.connected ||
    !(props.historyReady || props.draftMode) ||
    props.agentStatus !== "ready" ||
    props.sending ||
    props.configuring ||
    props.preparing;
  const editorDisabled = props.allowControlInput
    ? !props.connected || props.configuring || Boolean(props.preparing)
    : props.draftMode
    ? props.sending || props.configuring || Boolean(props.preparing)
    : disabled;
  const commands = props.commands ?? [];
  const commandKey = JSON.stringify([props.commandScope, props.value,
    commands.map(({ name }) => name)]);
  const commandMenuOpen = editorFocused && !editorDisabled &&
    props.value.startsWith("/") && !/\s/u.test(props.value) &&
    dismissedCommandKey !== commandKey;
  const commandMatches = commandMenuOpen
    ? commands.filter(({ name }) => name.toLowerCase().includes(props.value.slice(1).toLowerCase()))
    : [];
  const activeCommandIndex = activeCommand.key === commandKey
    ? Math.min(activeCommand.index, Math.max(0, commandMatches.length - 1)) : 0;
  const selectCommand = (command: WorkspaceCommand) => {
    const value = `/${command.name}${command.input ? " " : ""}`;
    setDismissedCommandKey(JSON.stringify([props.commandScope, value, commands.map(({ name }) => name)]));
    props.onChange(value);
    textarea.current?.focus({ preventScroll: true });
  };
  const hint = props.allowControlInput && props.attachments.length && props.controlInput
    ? "Remove attachments before running a command"
    : props.allowControlInput && props.sending
    ? "Agent is working. Commands remain available."
    : props.openingFailure
    ? "Conversation history unavailable"
    : props.openingHistory
      ? "Opening conversation history"
      : props.preparing
        ? "Preparing conversation"
        : props.configuring
          ? "Updating session settings"
          : !props.historyReady && !props.draftMode && props.connected && !props.sending
            ? "Conversation not yet synchronized"
            : statusCopy(props.agentStatus, props.connected, props.sending);
  const submitEnabled = props.controlInput ? Boolean(props.controlEnabled) :
    canSubmit({
      text: props.value,
      attachments: props.attachments,
      agentStatus: props.agentStatus,
      connected: props.connected && (props.historyReady || Boolean(props.draftMode)),
      configuring: props.configuring || Boolean(props.preparing),
    }) && !props.sending && !props.sendBlocked && !props.commanding;
  useLayoutEffect(() => {
    if (!editorDisabled) {
      if (restoreEditorFocus.current && document.activeElement === document.body)
        textarea.current?.focus({ preventScroll: true });
      restoreEditorFocus.current = false;
      return;
    }
    if (!restoreEditorFocus.current) return;
    const abandon = (event: Event) => {
      if (event.type === "pointerdown" ||
        (event.target !== textarea.current && event.target !== document.body))
        restoreEditorFocus.current = false;
    };
    document.addEventListener("focusin", abandon);
    document.addEventListener("pointerdown", abandon);
    return () => {
      document.removeEventListener("focusin", abandon);
      document.removeEventListener("pointerdown", abandon);
    };
  }, [editorDisabled]);
  useLayoutEffect(() => {
    const pending = pendingRemovalFocus.current;
    if (!pending || props.attachments.some((attachment) => attachment.id === pending.id))
      return;
    pendingRemovalFocus.current = null;
    if (document.activeElement !== document.body) return;
    const next = props.attachments[Math.min(pending.index, props.attachments.length - 1)];
    if (next) removeButtons.current.get(next.id)?.focus({ preventScroll: true });
    else if (!editorDisabled) textarea.current?.focus({ preventScroll: true });
    else expandButton.current?.focus({ preventScroll: true });
  }, [props.attachments, editorDisabled]);

  return (
    <div className="composer-region" ref={props.rootRef}>
      {props.feedback}
      <div
        className={`composer ${expanded ? "composer-expanded" : ""} ${submitEnabled ? "composer-ready" : ""}`}
        role="group"
        aria-label="Message composer"
      >
        {commandMenuOpen ? <CommandMenu
          id={commandMenuId}
          commands={commandMatches}
          activeIndex={activeCommandIndex}
          emptyMessage={props.draftMode ? "Commands become available after your first message."
            : commands.length ? "No matching commands" : "No commands available in this conversation"}
          onActive={(index) => setActiveCommand({ key: commandKey, index })}
          onSelect={selectCommand}
        /> : null}
        {props.attachments.length ? (
          <div className="composer-attachments">
            {props.attachments.map((attachment, index) => {
              const Icon =
                attachment.kind === "image"
                  ? ImageIcon
                  : attachment.kind === "audio"
                    ? AudioLines
                    : FileText;
              return (
                <div className="composer-attachment" key={attachment.id}>
                  {attachment.kind === "image" && attachment.previewURL ? (
                    <img src={attachment.previewURL} alt="" />
                  ) : (
                    <Icon size={15} aria-hidden="true" />
                  )}
                  <span>
                    <strong title={attachment.name}>{attachment.name}</strong>
                    <small>{attachment.sizeLabel}</small>
                  </span>
                  <button
                    type="button"
                    ref={(node) => {
                      if (node) removeButtons.current.set(attachment.id, node);
                      else removeButtons.current.delete(attachment.id);
                    }}
                    onClick={(event) => {
                      if (document.activeElement === event.currentTarget)
                        pendingRemovalFocus.current = { id: attachment.id, index };
                      props.onRemoveAttachment(attachment.id);
                    }}
                    aria-label={`Remove ${attachment.name}`}
                    title={`Remove ${attachment.name}`}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <textarea
          ref={textarea}
          role="combobox"
          aria-label="Message"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={commandMenuOpen}
          aria-controls={commandMenuOpen ? commandMenuId : undefined}
          aria-activedescendant={commandMenuOpen && commandMatches.length
            ? `${commandMenuId}-${activeCommandIndex}` : undefined}
          aria-describedby={hint ? hintId : undefined}
          disabled={editorDisabled}
          onFocus={() => setEditorFocused(true)}
          onBlur={() => setEditorFocused(false)}
          onChange={(event) => {
            setDismissedCommandKey(null);
            props.onChange(event.target.value);
          }}
          onKeyDown={(event) => {
            // Some IMEs report the confirmation key after compositionend with code 229.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (commandMenuOpen) {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDismissedCommandKey(commandKey);
                return;
              }
              if (commandMatches.length && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setActiveCommand({ key: commandKey,
                    index: (activeCommandIndex + direction + commandMatches.length) % commandMatches.length });
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  selectCommand(commandMatches[activeCommandIndex]!);
                  return;
                }
              }
            }
            if (event.key === "Escape" && expanded) {
              event.preventDefault();
              setExpanded(false);
              return;
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault();
              if (submitEnabled) {
                restoreEditorFocus.current = true;
                props.onSubmit();
              }
            }
          }}
          placeholder={commands.length ? "Message your agent, or type / for commands" : "Message your agent"}
          rows={1}
          value={props.value}
        />
        <div className={hint ? "composer-hint" : "sr-only"} id={hintId} role="status">
          {hint}
        </div>
        <div className="composer-actions">
          <input
            ref={fileInput}
            className="sr-only"
            tabIndex={-1}
            aria-label="File attachments"
            type="file"
            multiple
            accept={props.fileAccept}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.files?.length) props.onFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <div className="composer-controls">
            <button
              type="button"
              className="icon-button"
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
              title="Attach files"
              aria-label="Attach files"
            >
              <Paperclip size={17} aria-hidden="true" />
            </button>
            {props.sessionControls}
          </div>
          <div className="composer-submit-controls">
            {props.usage}
            <button
              ref={expandButton}
              type="button"
              className="icon-button"
              title={
                expanded ? "Collapse message editor" : "Expand message editor"
              }
              aria-label={
                expanded ? "Collapse message editor" : "Expand message editor"
              }
              aria-pressed={expanded}
              onClick={() => {
                setExpanded(!expanded);
                textarea.current?.focus();
              }}
            >
              {expanded ? (
                <Minimize2 size={16} aria-hidden="true" />
              ) : (
                <Maximize2 size={16} aria-hidden="true" />
              )}
            </button>
            {props.preparing ? (
              <button type="button" className="send-button" disabled
                title="Preparing conversation" aria-label="Preparing conversation">
                <LoaderCircle className="spin" size={17} aria-hidden="true" />
              </button>
            ) : props.controlInput ? (
              <button type="button" className="send-button" disabled={!submitEnabled}
                onClick={props.onSubmit} title="Run command" aria-label="Run command">
                {props.commanding ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <ArrowUp size={17} aria-hidden="true" />}
              </button>
            ) : props.sending || props.cancellable ? (
              <button
                type="button"
                className="send-button stop-button"
                disabled={props.cancelling || !props.cancellable}
                onClick={props.onCancel}
                title="Stop operation"
                aria-label="Stop operation"
              >
                {props.cancelling ? (
                  <LoaderCircle className="spin" size={17} aria-hidden="true" />
                ) : (
                  <Square size={15} fill="currentColor" aria-hidden="true" />
                )}
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                disabled={!submitEnabled}
                onClick={(event) => {
                  if (event.detail === 0) restoreEditorFocus.current = true;
                  props.onSubmit();
                }}
                aria-label="Send message"
                title="Send message"
              >
                <ArrowUp size={17} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
