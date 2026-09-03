import { ArrowUp, FilePlus2, FileText, Image as ImageIcon, LoaderCircle, Square, X } from "lucide-react";
import { useRef } from "react";
import type { AgentStatus, Attachment } from "../lib/types";
import { canSubmit } from "../lib/presentation";

type Props = {
  value: string;
  attachments: Attachment[];
  agentStatus: AgentStatus;
  connected: boolean;
  sending: boolean;
  cancelling: boolean;
  onChange: (value: string) => void;
  onFiles: (files: FileList) => void;
  onRemoveAttachment: (id: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

function statusCopy(agentStatus: AgentStatus, connected: boolean, sending: boolean): string {
  if (!connected) return "Connection unavailable";
  if (agentStatus === "offline") return "Agent is offline";
  if (sending) return "Agent is working · stop when needed";
  if (agentStatus === "busy") return "Agent is finishing another operation";
  return "Enter to send · Shift + Enter for a new line";
}

export function Composer(props: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const submitEnabled = canSubmit({
    text: props.value,
    attachments: props.attachments,
    agentStatus: props.agentStatus,
    connected: props.connected,
  }) && !props.sending;

  return (
    <div className="composer-region">
      <div className={`composer ${submitEnabled ? "composer-ready" : ""}`}>
        {props.attachments.length ? (
          <div className="composer-attachments">
            {props.attachments.map((attachment) => {
              const Icon = attachment.kind === "image" ? ImageIcon : FileText;
              return (
                <div className="composer-attachment" key={attachment.id}>
                  {attachment.previewURL ? <img src={attachment.previewURL} alt="" /> : <Icon size={15} aria-hidden="true" />}
                  <span><strong>{attachment.name}</strong><small>{attachment.sizeLabel}</small></span>
                  <button type="button" onClick={() => props.onRemoveAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <textarea
          aria-label="Message"
          disabled={!props.connected || props.agentStatus !== "ready" || props.sending}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (submitEnabled) props.onSubmit();
            }
          }}
          placeholder="Message your agent"
          rows={1}
          value={props.value}
        />
        <div className="composer-actions">
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.md,.csv,.json"
            onChange={(event) => {
              if (event.target.files?.length) props.onFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="icon-button"
            disabled={!props.connected || props.agentStatus !== "ready" || props.sending}
            onClick={() => fileInput.current?.click()}
            title="Attach files"
            aria-label="Attach files"
          >
            <FilePlus2 size={17} aria-hidden="true" />
          </button>
          <span className="composer-hint">{statusCopy(props.agentStatus, props.connected, props.sending)}</span>
          {props.sending ? (
            <button
              type="button"
              className="send-button stop-button"
              disabled={props.cancelling}
              onClick={props.onCancel}
              title="Stop operation"
              aria-label="Stop operation"
            >
              {props.cancelling ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Square size={15} fill="currentColor" aria-hidden="true" />}
            </button>
          ) : (
            <button
              type="button"
              className="send-button"
              disabled={!submitEnabled}
              onClick={props.onSubmit}
              aria-label="Send message"
            >
              <ArrowUp size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
