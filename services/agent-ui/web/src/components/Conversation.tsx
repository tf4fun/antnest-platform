import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, ListChecks,
  LoaderCircle, RotateCcw } from "lucide-react";
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
import { ConversationEmpty } from "./ConversationEmpty";
import { isWorkspaceReadTimeout } from "../lib/workspace-api-client";

type DisclosureProps = {
  atBottom?: boolean;
  canAutoCollapse?: () => boolean;
  onProcessToggle?: () => void;
  onLoadContent?: (messageId: string) => Promise<void> | void;
  onLoadProcess?: (turnId: string) => Promise<void> | void;
  onCancelProcess?: (turnId: string) => void;
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
  onCancelProcess,
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
    return <ConversationEmpty agent={agent} />;
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
          onCancelProcess={onCancelProcess}
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
  onCancelProcess,
  onUnloadProcess,
}: {
  turn: Turn;
  number: number;
  agent: AgentSummary;
  completed: boolean;
} & DisclosureProps) {
  const panelId = useId();
  const liveProcess = turn.prompt?.turnOutcome === "running";
  const [compact, setCompact] = useState(completed);
  const [expanded, setExpanded] = useState(liveProcess);
  const [retained, setRetained] = useState(!completed);
  const [loadingProcess, setLoadingProcess] = useState(false);
  const [processError, setProcessError] = useState<"timeout" | "error" | null>(null);
  const autoRequested = useRef(false);
  const liveRequestedKey = useRef<string | null>(null);
  const processTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterProcessPage = useRef(false);
  const wasLive = useRef(liveProcess);
  useLayoutEffect(() => {
    if (!completed) setCompact(false);
    else if (canAutoCollapse?.() ?? atBottom) setCompact(true);
  }, [completed, atBottom, canAutoCollapse]);
  useEffect(() => {
    if (liveProcess && !wasLive.current) setExpanded(true);
    if (!liveProcess && wasLive.current && (canAutoCollapse?.() ?? atBottom))
      setExpanded(false);
    wasLive.current = liveProcess;
  }, [liveProcess, atBottom, canAutoCollapse]);
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
  const loadProcessPage = () => {
    if (!onLoadProcess || loadingProcess) return;
    setLoadingProcess(true);
    setProcessError(null);
    void Promise.resolve().then(() => onLoadProcess(turn.id.slice(0, -7)))
      .catch((cause: unknown) => setProcessError(isWorkspaceReadTimeout(cause) ? "timeout" : "error"))
      .finally(() => setLoadingProcess(false));
  };
  useEffect(() => {
    if (liveProcess || !expanded || !processCount || turn.prompt?.processLoaded ||
      !onLoadProcess || autoRequested.current) return;
    autoRequested.current = true;
    loadProcessPage();
  }, [liveProcess, expanded, processCount, turn.prompt?.processLoaded, onLoadProcess,
    turn.id]);
  const liveRequestKey = liveProcess && expanded && processCount > 0 &&
    (!turn.prompt?.processLoaded || turn.prompt.processHasMore)
    ? JSON.stringify([turn.prompt?.processVersion, processCount, turn.process.length,
      turn.prompt?.processHasMore ?? false]) : null;
  useEffect(() => {
    if (liveRequestKey === null || !onLoadProcess || loadingProcess || processError ||
      liveRequestedKey.current === liveRequestKey) return;
    liveRequestedKey.current = liveRequestKey;
    loadProcessPage();
  }, [liveRequestKey, onLoadProcess, loadingProcess, processError]);
  useLayoutEffect(() => {
    if (!focusAfterProcessPage.current || loadingProcess) return;
    if (!processError && !turn.prompt?.processHasMore &&
      document.activeElement === document.body)
      processTriggerRef.current?.focus({ preventScroll: true });
    focusAfterProcessPage.current = false;
  }, [loadingProcess, processError, turn.prompt?.processHasMore]);
  const processLabel = bridgeProcess
    ? `${processCount} ${processCount === 1 ? "update" : "updates"}` : tools.length
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
              ref={processTriggerRef}
              aria-label={`${expanded ? "Hide" : "Show"} process`}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => {
                onProcessToggle?.();
                setRetained(true);
                if (!expanded) { setProcessError(null); autoRequested.current = false;
                  liveRequestedKey.current = null; }
                else if (bridgeProcess) onCancelProcess?.(turn.id.slice(0, -7));
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
            aria-busy={loadingProcess}
          >
            {(!folded && !bridgeProcess) || expanded || retained ? entries.map(entry) : null}
            {expanded && bridgeProcess ? <div className="turn-process-pagination">
              <div className="turn-process-page-status">
                {loadingProcess ? <span className="turn-process-loading" role="status">
                  <LoaderCircle size={13} className="spin" aria-hidden="true" />
                  <span>Loading process</span>
                </span> : null}
                {processError ? <span className="turn-process-load-error" role="alert">
                  <CircleAlert size={13} aria-hidden="true" />
                  <span>{processError === "timeout" ? "Process request timed out." :
                    "Process could not be loaded."}</span>
                </span> : null}
                {turn.prompt?.processLoaded ? <span className="turn-process-loaded" role="status">
                  Loaded {turn.process.length} of {processCount} updates
                </span> : null}
              </div>
              {(processError || turn.prompt?.processHasMore) && onLoadProcess ?
                <button type="button" className="load-more-process" disabled={loadingProcess}
                  onClick={(event) => {
                    focusAfterProcessPage.current = event.detail === 0 &&
                      document.activeElement === event.currentTarget;
                    loadProcessPage();
                  }}>
                  {processError ? <RotateCcw size={13} aria-hidden="true" /> :
                    <ChevronDown size={13} aria-hidden="true" />}
                  {processError ? "Retry process" :
                    loadingProcess ? "Loading process" : "Load more process"}
                </button> : null}
            </div> : null}
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
