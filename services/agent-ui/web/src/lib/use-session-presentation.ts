import { useReducer, useRef, type SetStateAction } from "react";
import { emptyPresentation, reduceSessionPresentation, sessionKey, type InteractionPhase } from "./session-presentation";
import type { Attachment } from "./types";

// Only presentation is cached. A new connection must re-observe server activity.
export function useSessionPresentation(agentId: string, sessionId: string | null) {
  const [sessions, dispatch] = useReducer(reduceSessionPresentation, {});
  const latest = useRef(sessions);
  latest.current = sessions;
  const key = sessionKey(agentId, sessionId);
  const current = sessions[key] ?? emptyPresentation();
  const owned = Object.entries(sessions).filter(([key]) => JSON.parse(key)[0] === agentId);
  const running = owned.find(([, value]) => value.phase === "running");
  const resolve = <T,>(value: SetStateAction<T>, previous: T): T => typeof value === "function" ? (value as (previous: T) => T)(previous) : value;
  const phase = (phase: InteractionPhase, target = key) => dispatch({ type: "phase", key: target, phase });
  return {
    draft: current.text, attachments: current.attachments, error: current.error,
    allAttachments: Object.values(sessions).flatMap(value => value.attachments),
    sending: Boolean(running), configuring: current.phase === "configuring",
    setDraft: (value: SetStateAction<string>) => dispatch({ type: "draft", key, text: resolve(value, latest.current[key]?.text ?? "") }),
    setAttachments: (value: SetStateAction<Attachment[]>) => dispatch({ type: "attachments", key, attachments: resolve(value, latest.current[key]?.attachments ?? []) }),
    setSending: (value: boolean) => phase(value ? "running" : "idle", running?.[0] ?? key),
    setConfiguring: (value: boolean) => phase(value ? "configuring" : "idle"),
    restore: (sessionId: string | null, text: string, attachments: Attachment[], error?: string) => dispatch({ type: "restore", key: sessionKey(agentId, sessionId), text, attachments, error }),
    move: (sessionId: string) => dispatch({ type: "move", key, target: sessionKey(agentId, sessionId) }),
    setError: (error?: string) => dispatch({ type: "error", key, error }),
    clear: () => dispatch({ type: "clear" }),
    disconnect: (agentId: string) => dispatch({ type: "disconnected", agentId }),
  };
}
