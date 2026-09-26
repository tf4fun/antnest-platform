import type { Session } from "./types";

export function agentWorkspacePath(agentID: string): string {
  if (!validWorkspaceID(agentID) || agentID === "assets") throw new Error("Invalid workspace Agent");
  return `/workspace/${encodeURIComponent(agentID)}/`;
}

function validWorkspaceID(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= 200 &&
    value.trim() === value && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f]/.test(value);
}

function workspaceReturnPath(value: string | null): string | undefined {
  if (value === "/workspace/") return value;
  const match = value?.match(/^\/workspace\/([^/?#\\]+)\/(?:sessions\/([^/?#\\]+))?$/);
  if (!match) return undefined;
  try {
    const agentId = decodeURIComponent(match[1]!);
    const sessionId = match[2] === undefined ? null : decodeURIComponent(match[2]);
    if (!validWorkspaceID(agentId) || agentId === "assets" ||
      (sessionId !== null && !validWorkspaceID(sessionId))) return undefined;
    const base = agentWorkspacePath(agentId);
    return sessionId === null ? base : `${base}sessions/${encodeURIComponent(sessionId)}`;
  } catch { return undefined; }
}

export function sessionDestination(session: Session, returnTo: string | null): string | undefined {
  const workspace = workspaceReturnPath(returnTo);
  if (workspace) return workspace;
  const administrator = session.principal.system_role === "admin" || session.principal.organization_role === "admin";
  return administrator ? undefined : "/workspace/";
}
