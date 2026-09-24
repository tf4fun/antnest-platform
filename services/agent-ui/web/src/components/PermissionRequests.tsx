import { ShieldCheck, Check, X } from "lucide-react";
import { useId, useLayoutEffect, useRef } from "react";
import type { PendingPermission } from "../lib/permissions";

export function PermissionRequests({
  requests,
  onAnswer,
  conversations,
  onOpen,
  disabled = false,
}: {
  requests: PendingPermission[];
  conversations: readonly { id: string; title: string }[];
  onOpen: (id: string) => void;
  onAnswer: (id: string, optionId: string) => void;
  disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const focusedDecision = useRef<string | null>(null);
  const descriptionPrefix = useId();
  useLayoutEffect(() => {
    const id = focusedDecision.current;
    if (!id || requests.some((item) => item.id === id)) return;
    focusedDecision.current = null;
    if (document.activeElement !== document.body) return;
    const next = root.current?.querySelector<HTMLButtonElement>(
      ".permission-options button",
    );
    (next ?? document.querySelector<HTMLElement>(
      '[role="region"][aria-label="Conversation messages"]',
    ))?.focus({ preventScroll: true });
  }, [requests]);
  const latest = requests.at(-1)?.request;
  const brief = (value: string) => Array.from(value.replace(/\s+/g, " ").trim())
    .slice(0, 64).join("");
  const latestTool = latest ? brief(latest.toolCall.title || "Tool execution") : "";
  const latestConversation = latest ? brief(conversations.find((item) =>
    item.id === latest.sessionId)?.title || latest.sessionId) : "";
  return (
    <>
      <p className="sr-only" role="status" aria-atomic="true">
        {latest ? (
          <>
            {requests.length} tool approval{requests.length === 1 ? "" : "s"}{" "}
            require{requests.length === 1 ? "s" : ""} a decision. Most recent:{" "}
            {latestTool} in {latestConversation}.
          </>
        ) : null}
      </p>
      {latest ? (
        <div className="permission-requests" ref={root}>
          {requests.map(({ id, request }, index) => {
            const conversationId = `${descriptionPrefix}-${index}-conversation`;
            const toolId = `${descriptionPrefix}-${index}-tool`;
            const description = `${conversationId} ${toolId}`;
            return (
              <section
                className="permission-request"
                key={id}
                aria-label="Tool approval"
                aria-describedby={description}
              >
                <header>
                  <ShieldCheck size={18} aria-hidden="true" />
                  <strong>Permission required</strong>
                </header>
                <button
                  id={conversationId}
                  type="button"
                  className="permission-conversation"
                  onClick={() => onOpen(request.sessionId)}
                >
                  Conversation:{" "}
                  {conversations.find((item) => item.id === request.sessionId)
                    ?.title || request.sessionId}
                </button>
                <p id={toolId}>{request.toolCall.title || "Tool execution"}</p>
                <pre tabIndex={0} role="region" aria-label="Requested tool input"
                  aria-describedby={description}>
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
                        disabled={disabled}
                        aria-describedby={description}
                        onClick={(event) => {
                          if (document.activeElement === event.currentTarget)
                            focusedDecision.current = id;
                          onAnswer(id, option.optionId);
                        }}
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
            );
          })}
        </div>
      ) : null}
    </>
  );
}
