import { ArrowDown, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import type { AgentSummary, Conversation as ConversationModel } from "../lib/types";

const Conversation = lazy(() => import("./Conversation").then(module => ({ default: module.Conversation })));

export function Thread({ agent, conversation, working }: { agent: AgentSummary; conversation?: ConversationModel; working: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const goToBottom = () => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    following.current = true;
    setAtBottom(true);
  };
  useLayoutEffect(goToBottom, [agent.id, conversation?.id]);
  useLayoutEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [conversation, working]);
  useLayoutEffect(() => {
    if (!content.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return <div className="thread-body">
    <div className="thread-scroll" ref={scroll} tabIndex={0} aria-label="Conversation messages" onScroll={event => {
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      setAtBottom(following.current);
    }}>
      <div className="thread-width" ref={content}>
        <Suspense fallback={<div className="agent-working" role="status">Opening conversation</div>}><Conversation agent={agent} conversation={conversation} /></Suspense>
        {working ? <div className="agent-working" role="status"><LoaderCircle className="spin" size={15} />Working</div> : null}
      </div>
    </div>
    {!atBottom ? <button className="scroll-to-bottom icon-button" type="button" onClick={goToBottom} title="Latest messages" aria-label="Latest messages"><ArrowDown size={18} /></button> : null}
  </div>;
}
