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
  type ReactNode,
} from "react";
import type { AgentStatus, Attachment } from "../lib/types";
import { canSubmit } from "../lib/presentation";

type Props = {
  sessionControls?: ReactNode;
  usage?: ReactNode;
  fileAccept: string;
  configuring: boolean;
  preparing?: boolean;
  historyReady: boolean;
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
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
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
    !props.historyReady ||
    props.agentStatus !== "ready" ||
    props.sending ||
    props.configuring ||
    props.preparing;
  const hint = props.preparing
    ? "Preparing conversation"
    : props.configuring
      ? "Updating session settings"
      : !props.historyReady && props.connected && !props.sending
        ? "Conversation not yet synchronized"
        : statusCopy(props.agentStatus, props.connected, props.sending);
  const submitEnabled =
    canSubmit({
      text: props.value,
      attachments: props.attachments,
      agentStatus: props.agentStatus,
      connected: props.connected && props.historyReady,
      configuring: props.configuring || Boolean(props.preparing),
    }) && !props.sending;

  return (
    <div className="composer-region">
      <div
        className={`composer ${expanded ? "composer-expanded" : ""} ${submitEnabled ? "composer-ready" : ""}`}
        role="group"
        aria-label="Message composer"
      >
        {props.attachments.length ? (
          <div className="composer-attachments">
            {props.attachments.map((attachment) => {
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
                    onClick={() => props.onRemoveAttachment(attachment.id)}
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
          aria-label="Message"
          aria-describedby={hint ? hintId : undefined}
          disabled={disabled}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && expanded) {
              event.preventDefault();
              setExpanded(false);
              return;
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (submitEnabled) props.onSubmit();
            }
          }}
          placeholder="Message your agent"
          rows={1}
          value={props.value}
        />
        {hint ? (
          <div className="composer-hint" id={hintId} role="status">
            {hint}
          </div>
        ) : null}
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
            {props.sending || props.cancellable ? (
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
                onClick={props.onSubmit}
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
