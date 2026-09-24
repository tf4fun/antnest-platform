import { Bot, Check, ChevronRight, ListChecks } from "lucide-react";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  onLoadContent?: (messageId: string) => void;
  onLoadProcess?: (turnId: string) => Promise<void> | void;
  onUnloadProcess?: (turnId: string) => void;
};

const FOLDED_PROCESS_RETENTION_MS = 5 * 60 * 1000;

export function Conversation({
  conversation,
  agent,
  settled = false,
  atBottom = true,
  canAutoCollapse,
  onProcessToggle,
  onLoadContent,
  onLoadProcess,
  onUnloadProcess,
  visibleStart,
  visibleEnd,
  historyGapAfter,
  loadingNewer = false,
  onLoadNewer,
}: {
  conversation: ConversationModel | undefined;
  agent: AgentSummary;
  settled?: boolean;
  visibleStart?: number;
  visibleEnd?: number;
  historyGapAfter?: number;
  loadingNewer?: boolean;
  onLoadNewer?: (button: HTMLButtonElement) => void;
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
  const start = visibleStart ?? 0;
  const visible = turns.slice(start, visibleEnd);
  return (
    <div className="conversation">
      {visible.map((turn, offset) => {
        const index = start + offset;
        return (
        <Fragment key={JSON.stringify([agent.id, conversation.id, turn.id])}>
        <ConversationTurn
          turn={turn}
          number={index + 1}
          agent={agent}
          completed={settled || index < turns.length - 1}
          atBottom={atBottom}
          canAutoCollapse={canAutoCollapse}
          onProcessToggle={onProcessToggle}
          onLoadContent={onLoadContent}
          onLoadProcess={onLoadProcess}
          onUnloadProcess={onUnloadProcess}
        />
        {historyGapAfter === index + 1 && onLoadNewer ? (
          <button type="button" className="load-older-turns"
            disabled={loadingNewer} onClick={(event) => onLoadNewer(event.currentTarget)}>
            {loadingNewer ? "Loading newer messages" : "Load newer messages"}
          </button>
        ) : null}
        </Fragment>
        );
      })}
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
  onLoadContent,
  onLoadProcess,
  onUnloadProcess,
}: {
  turn: Turn;
  number: number;
  agent: AgentSummary;
  completed: boolean;
} & DisclosureProps) {
  const panelId = useId();
  const [compact, setCompact] = useState(completed);
  const [expanded, setExpanded] = useState(false);
  const [retained, setRetained] = useState(!completed);
  const [loadingProcess, setLoadingProcess] = useState(false);
  const [processError, setProcessError] = useState(false);
  useLayoutEffect(() => {
    if (!completed) setCompact(false);
    else if (canAutoCollapse?.() ?? atBottom) setCompact(true);
  }, [completed, atBottom, canAutoCollapse]);
  const folded = completed && compact;
  const bridgeProcess = (turn.prompt?.processCount ?? 0) > 0;
  const unloadRef = useRef(onUnloadProcess);
  unloadRef.current = onUnloadProcess;
  useEffect(() => {
    if (!folded || expanded) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    const timeout = window.setTimeout(() => {
      setRetained(false);
      if (bridgeProcess) unloadRef.current?.(turn.id.slice(0, -7));
    }, FOLDED_PROCESS_RETENTION_MS);
    return () => window.clearTimeout(timeout);
  }, [folded, expanded, retained, bridgeProcess, turn.id]);
  const entries = folded || bridgeProcess ? turn.process : turn.response;
  const tools = turn.process.flatMap((message) => message.activities ?? []);
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const processCount = turn.prompt?.processCount ?? 0;
  const hasProcess = entries.length > 0 || (processCount > 0 && Boolean(onLoadProcess));
  useEffect(() => {
    if (!expanded || !processCount || turn.prompt?.processLoaded ||
      !onLoadProcess || loadingProcess || processError) return;
    setLoadingProcess(true);
    void Promise.resolve().then(() => onLoadProcess(turn.id.slice(0, -7)))
      .catch(() => setProcessError(true))
      .finally(() => setLoadingProcess(false));
  }, [expanded, processCount, turn.prompt?.processLoaded, onLoadProcess,
    turn.id, loadingProcess, processError]);
  const processLabel = tools.length
    ? `${tools.length} ${tools.length === 1 ? "tool call" : "tool calls"}`
    : `${turn.process.length || processCount} ${(turn.process.length || processCount) === 1 ? "update" : "updates"}`;
  const entry = (message: Message) => (
    <MessageView
      key={message.id}
      message={message}
      onDisclosure={onProcessToggle}
      onLoadContent={onLoadContent}
    />
  );
  return (
    <section className="conversation-turn" aria-label="Conversation exchange">
      <h3 className="turn-heading">
        <span>Exchange {number}</span>
      </h3>
      {turn.prompt ? <MessageView message={turn.prompt} onLoadContent={onLoadContent} /> : null}
      {turn.response.some((message) => message.role === "assistant") ? (
        <div className="turn-agent-label">
          <Bot size={15} aria-hidden="true" />
          <span>{agent.name}</span>
        </div>
      ) : null}
      {hasProcess ? (
        <div className="turn-process" data-complete={folded}>
          {folded || bridgeProcess ? (
            <button
              type="button"
              className="turn-process-trigger"
              aria-label={`${expanded ? "Hide" : "Show"} process`}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => {
                onProcessToggle?.();
                setRetained(true);
                if (!expanded) setProcessError(false);
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
            hidden={(folded || bridgeProcess) && !expanded}
          >
            {loadingProcess ? <p role="status">Loading process</p> : null}
            {processError ? <p role="alert">Process could not be loaded.</p> : null}
            {(!folded && !bridgeProcess) || expanded || retained ? entries.map(entry) : null}
            {expanded && turn.prompt?.processHasMore && onLoadProcess ? (
              <button type="button" className="load-more-process" disabled={loadingProcess}
                onClick={() => {
                  if (loadingProcess) return;
                  setLoadingProcess(true);
                  setProcessError(false);
                  void Promise.resolve().then(() => onLoadProcess(turn.id.slice(0, -7)))
                    .catch(() => setProcessError(true))
                    .finally(() => setLoadingProcess(false));
                }}>
                {loadingProcess ? "Loading process" : "Load more process"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {(folded || bridgeProcess) && turn.output ? (
        <MessageView key={turn.output.id} message={turn.output} answer onLoadContent={onLoadContent} />
      ) : null}
      {folded || bridgeProcess ? turn.notices.map(entry) : null}
      {turn.prompt?.turnOutcome === "failed" ? (
        <p className="turn-failure" role="alert" aria-label="Run failed">
          Run failed. The saved conversation is available; send a new message when the Agent is available.
        </p>
      ) : null}
    </section>
  );
}
