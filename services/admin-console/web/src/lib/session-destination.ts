import type { Session } from "./types";

export function agentWorkspacePath(agentID: string): string {
  return `/workspace/?${new URLSearchParams({ agent: agentID })}`;
}

function workspaceReturnPath(value: string | null): string | undefined {
  if (value === "/workspace/") return value;
  if (!value?.startsWith("/workspace/?") || value.includes("#")) return undefined;
  const params = new URLSearchParams(value.slice("/workspace/?".length));
  for (const [key, id] of params) {
    if (key !== "agent" && key !== "session") return undefined;
    if (params.getAll(key).length !== 1 || !id.trim() || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) return undefined;
  }
  if (!params.has("agent")) return undefined;
  return `/workspace/?${params}`;
}

export function sessionDestination(session: Session, returnTo: string | null): string | undefined {
  const workspace = workspaceReturnPath(returnTo);
  if (workspace) return workspace;
  const administrator = session.principal.system_role === "admin" || session.principal.organization_role === "admin";
  return administrator ? undefined : "/workspace/";
}
