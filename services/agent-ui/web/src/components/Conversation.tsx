import { Bot, Check, ChevronRight, ListChecks } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useState } from "react";
import type {
  AgentSummary,
  Conversation as ConversationModel,
  Message,
} from "../lib/types";
import {
  conversationTurns,
  type ConversationTurn as Turn,
} from "../lib/conversation-turns";
import { MessageView } from "./MessageView";

type DisclosureProps = {
  atBottom?: boolean;
  canAutoCollapse?: () => boolean;
  onProcessToggle?: () => void;
};

export function Conversation({
  conversation,
  agent,
  settled = false,
  atBottom = true,
  canAutoCollapse,
  onProcessToggle,
}: {
  conversation: ConversationModel | undefined;
  agent: AgentSummary;
  settled?: boolean;
} & DisclosureProps) {
  const turns = useMemo(
    () => conversationTurns(conversation?.messages ?? []),
    [conversation?.messages],
  );
  if (!conversation || !turns.length) {
    return (
      <div className="empty-thread">
        <span className="empty-thread-mark">
          <Bot size={22} aria-hidden="true" />
        </span>
        <h2>Start with {agent.name}</h2>
      </div>
    );
  }
  return (
    <div className="conversation">
      {turns.map((turn, index) => (
        <ConversationTurn
          key={JSON.stringify([agent.id, conversation.id, turn.id])}
          turn={turn}
          number={index + 1}
          agent={agent}
          completed={settled || index < turns.length - 1}
          atBottom={atBottom}
          canAutoCollapse={canAutoCollapse}
          onProcessToggle={onProcessToggle}
        />
      ))}
      {conversation.plan?.length ? (
        <details className="session-plan">
          <summary onClick={onProcessToggle}>
            <span className="disclosure-kind" aria-hidden="true">
              <ListChecks size={15} />
            </span>
            <strong>Plan</strong>
            <span className="plan-count">
              {
                conversation.plan.filter(
                  (entry) => entry.status === "completed",
                ).length
              }
              /{conversation.plan.length}
            </span>
            <ChevronRight
              size={14}
              className="disclosure-chevron"
              aria-hidden="true"
            />
          </summary>
          <ol>
            {conversation.plan.map((entry, index) => (
              <li key={`${index}-${entry.content}`} data-status={entry.status}>
                {entry.status === "completed" ? (
                  <Check size={14} aria-label="Completed" />
                ) : (
                  <span
                    className="plan-status"
                    aria-label={
                      entry.status === "in_progress" ? "In progress" : "Pending"
                    }
                  />
                )}
                <span>{entry.content}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

function ConversationTurn({
  turn,
  number,
  agent,
  completed,
  atBottom,
  canAutoCollapse,
  onProcessToggle,
}: {
  turn: Turn;
  number: number;
  agent: AgentSummary;
  completed: boolean;
} & DisclosureProps) {
  const panelId = useId();
  const [compact, setCompact] = useState(completed);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (!completed) setCompact(false);
    else if (canAutoCollapse?.() ?? atBottom) setCompact(true);
  }, [completed, atBottom, canAutoCollapse]);
  const folded = completed && compact;
  const entries = folded ? turn.process : turn.response;
  const tools = turn.process.flatMap((message) => message.activities ?? []);
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const processLabel = tools.length
    ? `${tools.length} ${tools.length === 1 ? "tool call" : "tool calls"}`
    : `${turn.process.length} ${turn.process.length === 1 ? "update" : "updates"}`;
  const entry = (message: Message) => (
    <MessageView
      key={message.id}
      message={message}
      onDisclosure={onProcessToggle}
    />
  );
  return (
    <section className="conversation-turn" aria-label="Conversation exchange">
      <h3 className="turn-heading">
        <span>Exchange {number}</span>
      </h3>
      {turn.prompt ? <MessageView message={turn.prompt} /> : null}
      {turn.response.some((message) => message.role === "assistant") ? (
        <div className="turn-agent-label">
          <Bot size={15} aria-hidden="true" />
          <span>{agent.name}</span>
        </div>
      ) : null}
      {entries.length ? (
        <div className="turn-process" data-complete={folded}>
          {folded ? (
            <button
              type="button"
              className="turn-process-trigger"
              aria-label={`${expanded ? "Hide" : "Show"} process`}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => {
                onProcessToggle?.();
                setExpanded((value) => !value);
              }}
            >
              <ListChecks size={15} aria-hidden="true" />
              <span className="turn-process-label">
                Process <span>{processLabel}</span>
              </span>
              {failed ? (
                <span className="process-failures">{failed} failed</span>
              ) : null}
              <ChevronRight
                size={15}
                className="disclosure-chevron"
                aria-hidden="true"
              />
            </button>
          ) : null}
          <div
            id={panelId}
            className="turn-process-content"
            hidden={folded && !expanded}
          >
            {entries.map(entry)}
          </div>
        </div>
      ) : null}
      {folded && turn.output ? (
        <MessageView key={turn.output.id} message={turn.output} answer />
      ) : null}
      {folded ? turn.notices.map(entry) : null}
    </section>
  );
}
