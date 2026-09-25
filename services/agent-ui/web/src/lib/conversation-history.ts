import type { Conversation, Message } from "./types";

export function compactCachedConversation(conversation: Conversation): Conversation {
  const messages: Message[] = [];
  let processPrefix: string | undefined;
  let changed = false;
  for (const item of conversation.messages) {
    if (item.role === "user") {
      processPrefix = item.id.endsWith(":prompt") &&
        (item.turnOutcome === "completed" || item.turnOutcome === "failed" ||
          item.turnOutcome === "cancelled") && (item.processCount ?? 0) > 0
        ? `${item.id.slice(0, -":prompt".length)}:process:` : undefined;
      if (processPrefix && (item.processLoaded || item.processHasMore !== undefined)) {
        const { processLoaded: _loaded, processHasMore: _more, ...rest } = item;
        messages.push({ ...rest, processLoaded: false });
        changed = true;
        continue;
      }
    } else if (processPrefix && item.id.startsWith(processPrefix)) {
      changed = true;
      continue;
    }
    messages.push(item);
  }
  return changed ? { ...conversation, messages } : conversation;
}

export function mergeConversationHistory(cached: Conversation | undefined, incoming: Conversation): Conversation {
  if (!cached || cached.agentId !== incoming.agentId || cached.id !== incoming.id ||
    !incoming.historyState ||
    incoming.historyState === "blocked") return incoming;
  return { ...incoming, messages: cached.messages, plan: cached.plan };
}
