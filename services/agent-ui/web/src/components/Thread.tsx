import { ArrowDown, LoaderCircle } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { conversationTurns } from "../lib/conversation-turns";
import type {
  AgentSummary,
  Conversation as ConversationModel,
} from "../lib/types";
import { SessionOpening } from "./SessionOpening";

const Conversation = lazy(() =>
  import("./Conversation").then((module) => ({ default: module.Conversation })),
);
const visibleTurnCount = 40;
const pageStep = 20;

export function Thread({
  agent,
  conversation,
  working,
  settled = false,
  opening = false,
  onLoadContent,
  onLoadProcess,
  onUnloadProcess,
  hasOlderTurns = false,
  onLoadOlder,
  hasNewerTurns = false,
  historyGapAfter,
  onLoadNewer,
  onShowLatest,
}: {
  agent: AgentSummary;
  conversation?: ConversationModel;
  working: boolean;
  settled?: boolean;
  opening?: boolean;
  onLoadContent?: (messageId: string) => void;
  onLoadProcess?: (turnId: string) => Promise<void> | void;
  onUnloadProcess?: (turnId: string) => void;
  hasOlderTurns?: boolean;
  onLoadOlder?: () => Promise<void> | void;
  hasNewerTurns?: boolean;
  historyGapAfter?: number;
  onLoadNewer?: () => Promise<void> | void;
  onShowLatest?: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [newerError, setNewerError] = useState(false);
  const [windowAnchor, setWindowAnchor] = useState<string | null>(null);
  const pendingOlderFirst = useRef<string | undefined>(undefined);
  const focusAfterNavigation = useRef<HTMLButtonElement | null>(null);
  const historyRequestGeneration = useRef(0);
  const pendingPrepend = useRef<{ height: number; top: number } | undefined>(undefined);
  const turns = useMemo(() => conversationTurns(conversation?.messages ?? []),
    [conversation?.messages]);
  const readOnly = conversation?.historyState === "blocked";
  const maxWindowStart = Math.max(0, turns.length - visibleTurnCount);
  const anchorIndex = windowAnchor === null ? -1
    : turns.findIndex((turn) => turn.id === windowAnchor);
  const windowStart = anchorIndex < 0 ? maxWindowStart
    : Math.min(anchorIndex, maxWindowStart);
  const canAutoCollapse = useCallback(() => following.current, []);
  const pauseFollowing = useCallback(() => {
    following.current = false;
    setAtBottom(false);
  }, []);
  const trackNavigationFocus = (button: HTMLButtonElement) => {
    if (document.activeElement === button) focusAfterNavigation.current = button;
  };
  const goToBottom = (button?: HTMLButtonElement) => {
    if (button) trackNavigationFocus(button);
    if (hasNewerTurns) onShowLatest?.();
    setWindowAnchor(null);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    following.current = true;
    setAtBottom(true);
  };
  useLayoutEffect(() => {
    historyRequestGeneration.current += 1;
    focusAfterNavigation.current = null;
    pendingOlderFirst.current = undefined;
    pendingPrepend.current = undefined;
    setLoadingOlder(false);
    setLoadingNewer(false);
    setOlderError(false);
    setNewerError(false);
    goToBottom();
  }, [agent.id, conversation?.id]);
  useLayoutEffect(() => {
    const button = focusAfterNavigation.current;
    if (!button) return;
    if (!button.isConnected) {
      if (document.activeElement === document.body)
        scroll.current?.focus({ preventScroll: true });
      focusAfterNavigation.current = null;
    }
  });
  useLayoutEffect(() => {
    const currentFirst = turns[0]?.id;
    if (pendingOlderFirst.current === undefined ||
      currentFirst === undefined || currentFirst === pendingOlderFirst.current) return;
    pendingOlderFirst.current = undefined;
    pendingPrepend.current = undefined;
    following.current = false;
    setAtBottom(false);
    setWindowAnchor(currentFirst);
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [turns]);
  useLayoutEffect(() => {
    const pending = pendingPrepend.current;
    if (pending && scroll.current) {
      scroll.current.scrollTop = pending.top + scroll.current.scrollHeight - pending.height;
      pendingPrepend.current = undefined;
      return;
    }
    if (following.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [conversation, working]);
  useLayoutEffect(() => {
    if (!content.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="thread-body">
      <div
        className="thread-scroll"
        ref={scroll}
        tabIndex={0}
        role="region"
        aria-label="Conversation messages"
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = windowStart === maxWindowStart &&
            element.scrollHeight - element.scrollTop - element.clientHeight <
            64;
          setAtBottom(following.current);
        }}
      >
        <div className="thread-width" ref={content}>
          <p className="sr-only" role="status" aria-label="History limited">
            {conversation?.historyState === "view_limited"
              ? "Conversation history is limited. Recent output is incomplete; full history is unavailable in this view."
              : null}
          </p>
          {conversation?.historyState === "view_limited" ? (
            <section className="limited-history">
              <h2>Conversation history is limited</h2>
              <p>The Agent may still be working. Recent output below is incomplete. Full history is unavailable in this view.</p>
              {conversation.limitedPreview?.text ? (
                <pre tabIndex={0} role="region" aria-label="Recent output preview">
                  {conversation.limitedPreview.text}
                </pre>
              ) : null}
            </section>
          ) : null}
          {!opening && windowStart > 0 ? (
            <button type="button" className="load-older-turns"
              onClick={(event) => {
                trackNavigationFocus(event.currentTarget);
                const earlier = turns[Math.max(0, windowStart - pageStep)];
                if (earlier === undefined) return;
                setWindowAnchor(earlier.id);
                following.current = false;
                setAtBottom(false);
                if (scroll.current) scroll.current.scrollTop = 0;
              }}>
              Show earlier loaded messages
            </button>
          ) : null}
          {!opening && !readOnly && windowStart === 0 && hasOlderTurns && onLoadOlder ? (
            <button
              type="button"
              className="load-older-turns"
              disabled={loadingOlder}
              onClick={(event) => {
                if (loadingOlder || loadingNewer) return;
                trackNavigationFocus(event.currentTarget);
                const generation = ++historyRequestGeneration.current;
                pendingOlderFirst.current = turns[0]?.id;
                if (scroll.current)
                  pendingPrepend.current = {
                    height: scroll.current.scrollHeight,
                    top: scroll.current.scrollTop,
                  };
                setLoadingOlder(true);
                setOlderError(false);
                void Promise.resolve().then(onLoadOlder).catch(() => {
                  if (generation !== historyRequestGeneration.current) return;
                  pendingOlderFirst.current = undefined;
                  pendingPrepend.current = undefined;
                  setOlderError(true);
                }).finally(() => {
                  if (generation === historyRequestGeneration.current)
                    setLoadingOlder(false);
                });
              }}
            >
              {loadingOlder ? "Loading earlier messages" : "Load earlier messages"}
            </button>
          ) : null}
          {olderError ? <p role="alert">Earlier messages could not be loaded.</p> : null}
          {newerError ? <p role="alert">Newer messages could not be loaded.</p> : null}
          {conversation?.historyState === "view_limited" ? null : opening ? (
            <SessionOpening />
          ) : (
            <Suspense
              fallback={
                <div className="agent-working" role="status">
                  Opening conversation
                </div>
              }
            >
              <Conversation
                agent={agent}
                conversation={conversation}
                settled={settled}
                atBottom={atBottom}
                canAutoCollapse={canAutoCollapse}
                onProcessToggle={pauseFollowing}
                onLoadContent={readOnly ? undefined : onLoadContent}
                onLoadProcess={readOnly ? undefined : onLoadProcess}
                onUnloadProcess={onUnloadProcess}
                visibleStart={windowStart}
                visibleEnd={windowStart + visibleTurnCount}
                historyGapAfter={readOnly ? undefined : historyGapAfter}
                loadingNewer={loadingNewer}
                onLoadNewer={!readOnly && hasNewerTurns && onLoadNewer ? (button) => {
                  if (loadingOlder || loadingNewer) return;
                  trackNavigationFocus(button);
                  const generation = ++historyRequestGeneration.current;
                  pendingOlderFirst.current = turns[0]?.id;
                  setLoadingNewer(true);
                  setNewerError(false);
                  void Promise.resolve().then(onLoadNewer).catch(() => {
                    if (generation !== historyRequestGeneration.current) return;
                    pendingOlderFirst.current = undefined;
                    setNewerError(true);
                  }).finally(() => {
                    if (generation === historyRequestGeneration.current)
                      setLoadingNewer(false);
                  });
                } : undefined}
              />
            </Suspense>
          )}
          {!opening && windowStart < maxWindowStart ? (
            <button type="button" className="load-older-turns"
              onClick={(event) => {
                trackNavigationFocus(event.currentTarget);
                const next = Math.min(maxWindowStart, windowStart + pageStep);
                if (next === maxWindowStart) goToBottom();
                else {
                  setWindowAnchor(turns[next]?.id ?? null);
                  if (scroll.current) scroll.current.scrollTop = 0;
                }
              }}>
              Show newer loaded messages
            </button>
          ) : null}
          {working && !opening ? (
            <div className="agent-working" role="status">
              <LoaderCircle className="spin" size={15} />
              Working
            </div>
          ) : null}
        </div>
      </div>
      {!atBottom ? (
        <button
          className="scroll-to-bottom icon-button"
          type="button"
          onClick={(event) => goToBottom(event.currentTarget)}
          title="Latest messages"
          aria-label="Latest messages"
        >
          <ArrowDown size={18} />
        </button>
      ) : null}
    </div>
  );
}
