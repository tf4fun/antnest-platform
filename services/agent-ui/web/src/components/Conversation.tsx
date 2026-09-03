import { Bot, FileText, Image as ImageIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentSummary, Attachment, Conversation as ConversationModel } from "../lib/types";
import { ToolActivity } from "./ToolActivity";

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const Icon = attachment.kind === "image" ? ImageIcon : FileText;
  return (
    <div className="message-attachment">
      {attachment.previewURL ? <img src={attachment.previewURL} alt="" /> : <Icon size={16} aria-hidden="true" />}
      <span>
        <strong>{attachment.name}</strong>
        <small>{attachment.sizeLabel}</small>
      </span>
    </div>
  );
}

export function Conversation({ conversation, agent }: { conversation: ConversationModel | undefined; agent: AgentSummary }) {
  if (!conversation || conversation.messages.length === 0) {
    return (
      <div className="empty-thread">
        <span className="empty-thread-mark"><Bot size={22} aria-hidden="true" /></span>
        <h2>Start with {agent.name}</h2>
        <p>Ask a question, share a file, or continue work from another conversation.</p>
      </div>
    );
  }

  return (
    <div className="conversation" aria-live="polite">
      {conversation.messages.map((message) => (
        <article className={`message message-${message.role}`} key={message.id}>
          {message.role === "assistant" ? (
            <span className="assistant-avatar" aria-label={agent.name}><Bot size={15} aria-hidden="true" /></span>
          ) : null}
          <div className="message-main">
            <header>
              <strong>{message.role === "assistant" ? agent.name : message.role === "system" ? "Antnest" : "You"}</strong>
              <time dateTime={message.createdAt}>
                {new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt))}
              </time>
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
              <div className="message-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}
