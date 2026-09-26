import type { WorkspaceSnapshot } from "./types";
import { compactCachedConversation } from "./conversation-history.ts";
import { parseWorkspaceDocumentPath, type WorkspaceRoute } from "../../server/src/protocol/workspace-route.ts";
export { workspacePath, type WorkspaceRoute } from "../../server/src/protocol/workspace-route.ts";

export function readWorkspaceRoute(path: string): WorkspaceRoute {
  return parseWorkspaceDocumentPath(path) ?? { agentId: "", sessionId: null };
}

export function selectWorkspaceRoute(workspace: WorkspaceSnapshot, route: WorkspaceRoute): WorkspaceSnapshot {
  const allowed = workspace.agents.some(agent => agent.id === route.agentId);
  const agentId = allowed ? route.agentId : "";
  const sessionId = allowed ? route.sessionId : null;
  const previousAgentId = workspace.activeAgentId;
  const previousSessionId = workspace.activeConversationId;
  const leaving = previousSessionId !== null &&
    (previousAgentId !== agentId || previousSessionId !== sessionId);
  return { ...workspace, activeAgentId: agentId, activeConversationId: sessionId,
    conversations: leaving ? workspace.conversations.map((conversation) =>
      conversation.agentId === previousAgentId && conversation.id === previousSessionId
        ? compactCachedConversation(conversation) : conversation) : workspace.conversations };
}
