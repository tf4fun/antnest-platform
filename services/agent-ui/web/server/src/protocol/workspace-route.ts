export type WorkspaceRoute = { agentId: string; sessionId: string | null };

function validIdentifier(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= 200 &&
    value.trim() === value && value !== "." && value !== ".." &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseWorkspaceDocumentPath(path: string): WorkspaceRoute | null {
  if (path === "/workspace/") return { agentId: "", sessionId: null };
  const match = /^\/workspace\/([^/?#\\]+)\/(?:sessions\/([^/?#\\]+))?$/.exec(path);
  if (!match) return null;
  try {
    const agentId = decodeURIComponent(match[1]!);
    const sessionId = match[2] === undefined ? null : decodeURIComponent(match[2]);
    if (!validIdentifier(agentId) || agentId === "assets" ||
      (sessionId !== null && !validIdentifier(sessionId))) return null;
    return { agentId, sessionId };
  } catch { return null; }
}

export function workspacePath(route: WorkspaceRoute): string {
  if (!route.agentId) return "/workspace/";
  if (!validIdentifier(route.agentId) || route.agentId === "assets" ||
    (route.sessionId !== null && !validIdentifier(route.sessionId)))
    throw new Error("Invalid workspace route identifier");
  const base = `/workspace/${encodeURIComponent(route.agentId)}/`;
  return route.sessionId === null ? base : `${base}sessions/${encodeURIComponent(route.sessionId)}`;
}
