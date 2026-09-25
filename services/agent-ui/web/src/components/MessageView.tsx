import {
  AudioLines,
  Brain,
  Check,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  ListChecks,
  UserRound,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Attachment, Message } from "../lib/types";
import { isWorkspaceReadTimeout } from "../lib/workspace-api-client";
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

function PlanActivity({ message, onDisclosure }: { message: Message;
  onDisclosure?: () => void }) {
  const [open, setOpen] = useState(true);
  const panelId = useId();
  const entries = message.planEntries;
  const completed = entries?.filter((entry) => entry.status === "completed").length ?? 0;
  return <section className="plan-card" aria-label="Plan">
    <button type="button" className="plan-card-trigger" aria-expanded={open}
      aria-controls={panelId} onClick={() => { onDisclosure?.(); setOpen((value) => !value); }}>
      <ListChecks size={15} aria-hidden="true" />
      <strong>Plan</strong>
      {entries ? <span className="plan-progress">{completed}/{entries.length}</span> : null}
      <ChevronRight size={15} className="disclosure-chevron" aria-hidden="true" />
    </button>
    <div id={panelId} className="plan-card-content" hidden={!open}>
      {entries ? <ol>{entries.map((entry, index) =>
        <li key={`${index}:${entry.content}`} data-status={entry.status}>
          {entry.status === "completed" ? <Check size={14} aria-label="Completed" /> :
            <span className="plan-status" aria-label={entry.status === "in_progress"
              ? "In progress" : "Pending"} />}
          <span>{entry.content}</span>
        </li>)}</ol> : message.content ? <Markdown text={message.content} /> : null}
    </div>
  </section>;
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
  onLoadContent?: (messageId: string) => Promise<void> | void;
}) {
  const [loadingContent, setLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<"timeout" | "error" | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const focusAfterContentLoad = useRef(false);
  useEffect(() => {
    if (!message.contentIncomplete) setContentError(null);
  }, [message.contentIncomplete, message.id]);
  useLayoutEffect(() => {
    if (!focusAfterContentLoad.current || loadingContent) return;
    if (!message.contentIncomplete && document.activeElement === document.body)
      articleRef.current?.focus({ preventScroll: true });
    focusAfterContentLoad.current = false;
  }, [loadingContent, message.contentIncomplete]);
  const loadContent = () => {
    if (!onLoadContent || loadingContent) return;
    setLoadingContent(true);
    setContentError(null);
    let pending: Promise<void>;
    try { pending = Promise.resolve(onLoadContent(message.id)); }
    catch (cause) { pending = Promise.reject(cause); }
    void pending
      .catch((cause: unknown) => setContentError(isWorkspaceReadTimeout(cause) ? "timeout" : "error"))
      .finally(() => setLoadingContent(false));
  };
  return (
    <article
      ref={articleRef}
      tabIndex={-1}
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
        {message.presentation === "plan" ? (
          <PlanActivity message={message} onDisclosure={onDisclosure} />
        ) : message.content ? (
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
              <button type="button" onClick={(event) => {
                focusAfterContentLoad.current = event.detail === 0 &&
                  document.activeElement === event.currentTarget;
                loadContent();
              }} disabled={loadingContent}>
                {loadingContent ? "Loading full content" :
                  contentError ? "Retry full content" : "Load full content"}
              </button>
            ) : null}
          </p>
        ) : null}
        {message.contentIncomplete && contentError ? <p role="alert">
          {contentError === "timeout" ? "Full content request timed out." :
            "Full content could not be loaded."}
        </p> : null}
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
