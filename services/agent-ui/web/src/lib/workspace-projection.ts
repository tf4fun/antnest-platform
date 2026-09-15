import type { Conversation, WorkspaceSnapshot } from "./types";
import { mergeConversationHistory } from "./conversation-history.ts";

export function sameIdentity(
  current: WorkspaceSnapshot,
  next: WorkspaceSnapshot,
): boolean {
  return (
    current.principal.userId === next.principal.userId &&
    current.principal.organizationId === next.principal.organizationId
  );
}

export function applyDiscovery(
  current: WorkspaceSnapshot,
  next: WorkspaceSnapshot,
): WorkspaceSnapshot {
  const same = sameIdentity(current, next);
  const visible = new Set(next.agents.map((agent) => agent.id));
  const activeAgentId =
    same && visible.has(current.activeAgentId) ? current.activeAgentId : "";
  return {
    ...current,
    principal: next.principal,
    agents: next.agents,
    activeAgentId,
    activeConversationId:
      same && activeAgentId === current.activeAgentId
        ? current.activeConversationId
        : null,
    conversations: same
      ? current.conversations.filter((session) => visible.has(session.agentId))
      : [],
  };
}

export function applyConversation(
  current: WorkspaceSnapshot,
  incoming: Conversation,
): WorkspaceSnapshot {
  const same = (session: Conversation) =>
    session.id === incoming.id && session.agentId === incoming.agentId;
  return {
    ...current,
    conversations: [
      mergeConversationHistory(current.conversations.find(same), incoming),
      ...current.conversations.filter((session) => !same(session)),
    ],
  };
}

export function applySessionCatalog(
  current: WorkspaceSnapshot,
  agentId: string,
  sessions: readonly Conversation[],
): WorkspaceSnapshot {
  const cached = new Map(
    current.conversations
      .filter((session) => session.agentId === agentId)
      .map((session) => [session.id, session]),
  );
  const incoming = sessions.filter((session) => session.agentId === agentId);
  const ids = new Set(incoming.map((session) => session.id));
  return {
    ...current,
    conversations: [
      ...incoming.map((session) =>
        mergeConversationHistory(cached.get(session.id), session),
      ),
      ...current.conversations.filter(
        (session) => session.agentId !== agentId || !ids.has(session.id),
      ),
    ],
  };
}
