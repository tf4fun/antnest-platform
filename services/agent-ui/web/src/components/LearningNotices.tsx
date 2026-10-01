import { Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentView } from "../../server/src/protocol/agent-view-delta.ts";
import type { LearningStatus } from "../../server/src/protocol/learning-status.ts";
import { workspacePath } from "../lib/navigation";

type LearningNotice = NonNullable<AgentView["systemNotices"]>[number];
const deferralMessages: Record<NonNullable<LearningStatus["blocked"]>["reason"], string> = {
  writer_present: "Learning is waiting for background writes to finish. You can keep chatting. To resume learning sooner, you can ask the agent to stop its background task.",
  unknown_effect: "Checking a previous Skill update before reporting its result.",
  model_unavailable: "An earlier review could not use its model. New completed tasks can be reviewed when the model is available.",
  runtime_unavailable: "An earlier review could not finish. New completed tasks can be reviewed when services are available.",
  review_inconclusive: "This review did not produce a verified Skill. No changes were applied.",
};

export function LearningNotices({
  agentId,
  ready,
  notices,
  onSelectSource,
  loadStatus,
}: {
  agentId: string;
  ready: boolean;
  notices: LearningNotice[];
  onSelectSource?: (sessionId: string) => void;
  loadStatus?: (signal: AbortSignal) => Promise<LearningStatus>;
}) {
  const observed = useRef<{
    agentId: string;
    initialized: boolean;
    ids: Set<string>;
    maxSequence: bigint;
  }>({
    agentId,
    initialized: false,
    ids: new Set(),
    maxSequence: 0n,
  });
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === agentId;
  const [fresh, setFresh] = useState<LearningNotice | null>(null);
  const [diagnostic, setDiagnostic] = useState<{
    agentId: string;
    status: LearningStatus | null;
  } | null>(null);

  useEffect(() => {
    setDiagnostic(null);
    if (!open || !ready || !loadStatus) return;
    const request = new AbortController();
    void Promise.resolve().then(() => loadStatus(request.signal)).then((status) => {
      if (request.signal.aborted) return;
      if (status.agentId !== agentId) throw new Error("Foreign learning status");
      setDiagnostic({ agentId, status });
    }).catch(() => {
      if (!request.signal.aborted) setDiagnostic({ agentId, status: null });
    });
    return () => request.abort();
  }, [agentId, open, ready, loadStatus]);

  useEffect(() => {
    if (observed.current.agentId !== agentId) {
      observed.current = {
        agentId,
        initialized: false,
        ids: new Set(),
        maxSequence: 0n,
      };
      setFresh(null);
      setOpenFor(null);
    }
    if (!ready) return;
    const current = observed.current;
    if (!current.initialized) {
      current.initialized = true;
      current.ids = new Set(notices.map((item) => item.changeId));
      for (const item of notices) {
        const sequence = BigInt(item.sequence);
        if (sequence > current.maxSequence) current.maxSequence = sequence;
      }
      return;
    }
    const newlyApplied = notices.filter(
      (item) => !current.ids.has(item.changeId),
    );
    let newest: LearningNotice | null = null;
    const previousMaximum = current.maxSequence;
    for (const item of newlyApplied) {
      current.ids.add(item.changeId);
      const sequence = BigInt(item.sequence);
      if (sequence > current.maxSequence) current.maxSequence = sequence;
      if (
        sequence > previousMaximum &&
        (newest === null || sequence > BigInt(newest.sequence))
      )
        newest = item;
    }
    if (newest !== null) setFresh(newest);
  }, [agentId, ready, notices]);

  function sourceLink(item: LearningNotice) {
    const sessionId = item.sourceSessionId;
    if (!sessionId || item.agentId !== agentId) return null;
    return <a className="learning-notices-source"
      href={workspacePath({ agentId, sessionId })}
      onClick={(event) => {
        if (!onSelectSource || event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey) return;
        event.preventDefault();
        setOpenFor(null);
        setFresh(null);
        onSelectSource(sessionId);
      }}>View source conversation</a>;
  }

  if (!loadStatus && notices.length === 0 && fresh === null) return null;
  const shownDiagnostic = ready && diagnostic?.agentId === agentId ? diagnostic : null;
  const blocked = shownDiagnostic?.status?.blocked;
  return (
    <div className="learning-notices">
      {loadStatus || notices.length > 0 ? (
        <button
          type="button"
          className="icon-button learning-notices-toggle"
          aria-label={`Skill learning results (${notices.length})`}
          aria-expanded={open}
          onClick={() => {
            setFresh(null);
            setOpenFor((value) => value === agentId ? null : agentId);
          }}
        >
          <Sparkles size={17} aria-hidden="true" />
          {notices.length > 0 ? <span className="learning-notices-count" aria-hidden="true">
            {notices.length}
          </span> : null}
        </button>
      ) : null}
      {open ? (
        <section
          className="learning-notices-panel"
          aria-label="Skill learning history"
        >
          <h2>Learned skills</h2>
          {notices.length === 0 ? <p className="learning-notices-empty">No learned skills yet.</p> : null}
          <ol>
            {[...notices].reverse().map((item) => (
              <li key={item.changeId}>
                <span className="learning-notices-kind">
                  {item.kind === "skill_created"
                    ? "New skill"
                    : "Skill updated"}
                </span>
                <strong>{item.changeSummary}</strong>
                {sourceLink(item)}
              </li>
            ))}
          </ol>
          {shownDiagnostic && (shownDiagnostic.status === null || blocked) ? (
            <div className="learning-notices-diagnostic">
              <h3>Background learning{blocked?.skillName ? ` · ${blocked.skillName}` : ""}</h3>
              <p>{shownDiagnostic.status === null ? "Learning status is unavailable." :
                blocked ? deferralMessages[blocked.reason] : ""}</p>
            </div>
          ) : null}
        </section>
      ) : null}
      {fresh ? (
        <div className="learning-notices-toast" role="status">
          <Sparkles size={16} aria-hidden="true" />
          <div>
            <strong>
              {fresh.kind === "skill_created"
                ? "New skill learned"
                : "Skill updated"}
            </strong>
            <p>{fresh.changeSummary}</p>
            {sourceLink(fresh)}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss learning result"
            onClick={() => setFresh(null)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
