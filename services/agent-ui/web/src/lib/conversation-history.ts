import type { Conversation } from "./types";

export function mergeConversationHistory(cached: Conversation | undefined, incoming: Conversation): Conversation {
  if (!cached || cached.agentId !== incoming.agentId || cached.id !== incoming.id ||
    !incoming.historyState || incoming.historyState === "view_limited" ||
    incoming.historyState === "blocked") return incoming;
  return { ...incoming, messages: cached.messages, plan: cached.plan };
}
