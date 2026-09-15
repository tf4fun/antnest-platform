import { AudioLines, Bot, Brain, Check, Copy, FileText, Image as ImageIcon, ListChecks } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentSummary, Attachment, Conversation as ConversationModel } from "../lib/types";
import { ToolActivity } from "./ToolActivity";

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const Icon = attachment.kind === "image" ? ImageIcon : attachment.kind === "audio" ? AudioLines : FileText;
  return (
    <div className={`message-attachment ${attachment.kind === "audio" ? "message-audio" : ""}`}>
      {attachment.kind === "image" && attachment.previewURL ? <img src={attachment.previewURL} alt="" /> : <Icon size={16} aria-hidden="true" />}
      <span>
        <strong>{attachment.name}</strong>
        <small>{attachment.sizeLabel}</small>
      </span>
      {attachment.kind === "audio" && attachment.previewURL ? <audio controls preload="none" src={attachment.previewURL} aria-label={attachment.name} /> : null}
    </div>
  );
}

function CopyMessage({ text }: { text: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  return <button className="icon-button message-copy" type="button" title={result === "failed" ? "Copy failed. Try again" : result === "copied" ? "Copied" : "Copy message"}
    aria-label={result === "failed" ? "Copy failed. Try again" : result === "copied" ? "Copied" : "Copy message"}
    onClick={async () => {
      try { await navigator.clipboard.writeText(text); setResult("copied"); }
      catch { setResult("failed"); }
    }}>
    {result === "copied" ? <Check size={14} /> : <Copy size={14} />}
  </button>;
}

export function Conversation({ conversation, agent }: { conversation: ConversationModel | undefined; agent: AgentSummary }) {
  if (!conversation || conversation.messages.length === 0) {
    return (
      <div className="empty-thread">
        <span className="empty-thread-mark"><Bot size={22} aria-hidden="true" /></span>
        <h2>Start with {agent.name}</h2>
      </div>
    );
  }

  return (
    <div className="conversation">
      {conversation.messages.map((message) => (
        <article className={`message message-${message.role}`} key={message.id}>
          {message.role === "assistant" ? (
            <span className="assistant-avatar" aria-label={agent.name}><Bot size={15} aria-hidden="true" /></span>
          ) : null}
          <div className="message-main">
            <header>
              <strong>{message.role === "assistant" ? agent.name : message.role === "system" ? "Antnest" : "You"}</strong>
              {message.createdAt ? <time dateTime={message.createdAt}>
                {new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt))}
              </time> : null}
            </header>
            {message.attachments?.length ? (
              <div className="message-attachments">
                {message.attachments.map((attachment) => <AttachmentView attachment={attachment} key={attachment.id} />)}
              </div>
            ) : null}
            {message.activities?.length ? (
              <div className="tool-list" aria-label="Agent activity">
                {message.activities.map((activity) => <ToolActivity activity={activity} key={activity.id} />)}
              </div>
            ) : null}
            {message.content ? (
              message.presentation === "thought" ? <details className="thought-process"><summary><Brain size={14} />Thinking</summary>
                <div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
              </details> : <>
                <div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
                <CopyMessage text={message.content} />
              </>
            ) : null}
          </div>
        </article>
      ))}
      {conversation.plan?.length ? <details className="session-plan"><summary><ListChecks size={16} />Plan <span>{conversation.plan.filter(entry => entry.status === "completed").length}/{conversation.plan.length}</span></summary>
        <ol>{conversation.plan.map((entry, index) => <li key={`${index}-${entry.content}`} data-status={entry.status}>
          {entry.status === "completed" ? <Check size={14} aria-label="Completed" /> : <span className="plan-status" aria-label={entry.status === "in_progress" ? "In progress" : "Pending"} />}
          <span>{entry.content}</span>
        </li>)}</ol>
      </details> : null}
    </div>
  );
}
