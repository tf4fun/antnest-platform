import {
  AudioLines,
  Brain,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  UserRound,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Attachment, Message } from "../lib/types";
import { ToolActivity } from "./ToolActivity";
import { CopyButton } from "./CopyButton";

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const Icon =
    attachment.kind === "image"
      ? ImageIcon
      : attachment.kind === "audio"
        ? AudioLines
        : FileText;
  return (
    <div
      className={`message-attachment ${attachment.kind === "audio" ? "message-audio" : ""}`}
    >
      {attachment.kind === "image" && attachment.previewURL ? (
        <img src={attachment.previewURL} alt={attachment.name} />
      ) : (
        <Icon size={16} aria-hidden="true" />
      )}
      <span>
        <strong title={attachment.name}>{attachment.name}</strong>
        <small>{attachment.sizeLabel}</small>
      </span>
      {attachment.kind === "audio" && attachment.previewURL ? (
        <audio
          controls
          preload="none"
          src={attachment.previewURL}
          aria-label={attachment.name}
        />
      ) : null}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="message-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <pre tabIndex={0} role="region" aria-label="Code block">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div
              className="markdown-table"
              tabIndex={0}
              role="region"
              aria-label="Table"
            >
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function MessageView({
  message,
  answer = false,
  onDisclosure,
  onLoadContent,
}: {
  message: Message;
  answer?: boolean;
  onDisclosure?: () => void;
  onLoadContent?: (messageId: string) => void;
}) {
  return (
    <article
      className={`message message-${message.role}${answer ? " message-answer" : ""}`}
    >
      <div className="message-main">
        {message.role === "user" ? (
          <header className="message-header">
            <UserRound size={14} aria-hidden="true" />
            <strong>You</strong>
          </header>
        ) : null}
        {message.role === "system" ? (
          <header className="message-header">
            <strong>Antnest</strong>
          </header>
        ) : null}
        {message.attachments?.length ? (
          <div className="message-attachments">
            {message.attachments.map((attachment) => (
              <AttachmentView attachment={attachment} key={attachment.id} />
            ))}
          </div>
        ) : null}
        {message.activities?.length ? (
          <div className="tool-list" aria-label="Agent activity">
            {message.activities.map((activity) => (
              <ToolActivity
                key={activity.id}
                activity={activity}
                onDisclosure={onDisclosure}
              />
            ))}
          </div>
        ) : null}
        {message.content ? (
          message.presentation === "thought" ? (
            <details className="thought-process">
              <summary onClick={onDisclosure}>
                <span className="thought-kind" aria-hidden="true">
                  <Brain size={15} />
                </span>
                <strong>Thinking</strong>
                <ChevronRight
                  size={14}
                  className="disclosure-chevron"
                  aria-hidden="true"
                />
              </summary>
              <Markdown text={message.content} />
            </details>
          ) : (
            <Markdown text={message.content} />
          )
        ) : null}
        {message.contentIncomplete ? (
          <p className="message-content-incomplete" role="status">
            More content available
            {onLoadContent ? (
              <button type="button" onClick={() => onLoadContent(message.id)}>
                Load full content
              </button>
            ) : null}
          </p>
        ) : null}
        {(answer || message.role !== "assistant") &&
        (message.createdAt || message.content) ? (
          <footer className="message-meta">
            {message.content && !message.contentIncomplete && (answer || message.role === "user") ? (
              <CopyButton
                text={message.content}
                label={answer ? "Copy response" : "Copy prompt"}
              />
            ) : null}
            {message.createdAt ? (
              <time dateTime={message.createdAt}>
                {new Intl.DateTimeFormat("en", {
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(message.createdAt))}
              </time>
            ) : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
}
