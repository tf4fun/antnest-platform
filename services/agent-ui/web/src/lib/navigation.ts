import type { WorkspaceSnapshot } from "./types";

export type WorkspaceRoute = { agentId: string; sessionId: string | null };

function identifier(query: URLSearchParams, key: string): string {
  const values = query.getAll(key);
  const value = values.length === 1 ? values[0] : "";
  return value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
}

export function readWorkspaceRoute(search: string): WorkspaceRoute {
  const query = new URLSearchParams(search);
  const agentId = identifier(query, "agent");
  return { agentId, sessionId: agentId ? identifier(query, "session") || null : null };
}

export function workspacePath(route: WorkspaceRoute): string {
  if (!route.agentId) return "/workspace/";
  const query = new URLSearchParams({ agent: route.agentId });
  if (route.sessionId) query.set("session", route.sessionId);
  return `/workspace/?${query}`;
}

export function selectWorkspaceRoute(workspace: WorkspaceSnapshot, route: WorkspaceRoute): WorkspaceSnapshot {
  const allowed = workspace.agents.some(agent => agent.id === route.agentId);
  return { ...workspace, activeAgentId: allowed ? route.agentId : "", activeConversationId: allowed ? route.sessionId : null };
}
