import type { Attachment } from "./types";

export type InteractionPhase = "idle" | "running" | "configuring";
export type SessionPresentation = { text: string; attachments: Attachment[]; phase: InteractionPhase; error?: string };
export type SessionPresentations = Record<string, SessionPresentation>;
export type PresentationAction =
  | { type: "draft"; key: string; text: string }
  | { type: "attachments"; key: string; attachments: Attachment[] }
  | { type: "phase"; key: string; phase: InteractionPhase }
  | { type: "restore"; key: string; text: string; attachments: Attachment[]; error?: string }
  | { type: "clearSubmitted"; key: string; text: string; attachmentIds: string[] }
  | { type: "move"; key: string; target: string }
  | { type: "error"; key: string; error?: string }
  | { type: "disconnected"; agentId: string }
  | { type: "clear" };

export function sessionKey(agentId: string, sessionId: string | null): string { return JSON.stringify([agentId, sessionId]); }
export function emptyPresentation(): SessionPresentation { return { text: "", attachments: [], phase: "idle" }; }

export function reduceSessionPresentation(state: SessionPresentations, action: PresentationAction): SessionPresentations {
  if (action.type === "clear") return {};
  if (action.type === "disconnected") {
    return Object.fromEntries(Object.entries(state).map(([key, value]) =>
      [key, JSON.parse(key)[0] === action.agentId ? { ...value, phase: "idle" } : value]));
  }
  const current = state[action.key] ?? emptyPresentation();
  switch (action.type) {
    case "move": {
      if (!state[action.key] || action.key === action.target) return state;
      const next = { ...state, [action.target]: current };
      delete next[action.key];
      return next;
    }
    case "draft": return { ...state, [action.key]: { ...current, text: action.text } };
    case "clearSubmitted":
      if (current.text !== action.text || current.attachments.length !== action.attachmentIds.length ||
        current.attachments.some((attachment, index) => attachment.id !== action.attachmentIds[index]))
        return state;
      return { ...state, [action.key]: { ...current, text: "", attachments: [] } };
    case "attachments": return { ...state, [action.key]: { ...current, attachments: action.attachments } };
    case "phase": return { ...state, [action.key]: { ...current, phase: action.phase } };
    case "error": return { ...state, [action.key]: { ...current, error: action.error } };
    case "restore": return { ...state, [action.key]: { ...current, text: current.text || action.text,
      attachments: current.attachments.length ? current.attachments : action.attachments, error: action.error } };
  }
}
