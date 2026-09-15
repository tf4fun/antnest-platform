import { ShieldCheck, Check, X } from "lucide-react";
import type { PendingPermission } from "../lib/permissions";

export function PermissionRequests({
  requests,
  onAnswer,
  conversations,
  onOpen,
}: {
  requests: PendingPermission[];
  conversations: readonly { id: string; title: string }[];
  onOpen: (id: string) => void;
  onAnswer: (id: string, optionId: string) => void;
}) {
  if (!requests.length) return null;
  return (
    <div className="permission-requests" aria-live="polite">
      {requests.map(({ id, request }) => (
        <section
          className="permission-request"
          key={id}
          aria-label="Tool approval"
        >
          <header>
            <ShieldCheck size={18} aria-hidden="true" />
            <strong>Permission required</strong>
          </header>
          <button
            type="button"
            className="permission-conversation"
            onClick={() => onOpen(request.sessionId)}
          >
            Conversation:{" "}
            {conversations.find((item) => item.id === request.sessionId)
              ?.title || request.sessionId}
          </button>
          <p>{request.toolCall.title || "Tool execution"}</p>
          <pre tabIndex={0} role="region" aria-label="Requested tool input">
            {JSON.stringify(request.toolCall.rawInput ?? {}, null, 2)}
          </pre>
          <div className="permission-options">
            {request.options.map((option) => {
              const allow = option.kind.startsWith("allow");
              return (
                <button
                  className="action-button"
                  data-decision={allow ? "allow" : "reject"}
                  type="button"
                  key={option.optionId}
                  onClick={() => onAnswer(id, option.optionId)}
                >
                  {allow ? (
                    <Check size={15} aria-hidden="true" />
                  ) : (
                    <X size={15} aria-hidden="true" />
                  )}
                  {option.name}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
