export type ConsolePage = "overview" | "directory" | "provisioning" | "models" | "templates" | "agents" | "audits";

export type ConsoleRoute = { page: ConsolePage; resourceID?: string; revisionID?: string; agentID?: string };

export function parseConsoleRoute(hash: string): ConsoleRoute {
  if (/^#\/?audits(?:\/|\?|$)/.test(hash)) return parseAuditRoute(hash);
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const page = parts[0];
  const resourceID = decodeResourceID(parts[1]);
  if (parts.length > 1 && !resourceID) return { page: "overview" };
  if ((page === "directory" || page === "provisioning") && parts.length === 1) return { page };
  if (page === "models" || page === "templates") {
    if (parts.length === 1) return { page };
    if (parts.length === 2) return { page, resourceID };
    if (page === "templates" && parts.length === 4 && parts[2] === "revisions") {
      const revisionID = parts[3];
      if (!revisionID || !/^\d+$/.test(revisionID)) return { page: "overview" };
      return { page, resourceID, revisionID };
    }
    return { page: "overview" };
  }
  if (page === "agents" && parts.length <= 2) return { page, resourceID };
  return { page: "overview" };
}

function decodeResourceID(value?: string): string | undefined {
  if (!value) return;
  try { return decodeURIComponent(value); } catch { return; }
}

function parseAuditRoute(hash: string): ConsoleRoute {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  const parts = path!.split("/");
  const filters = new URLSearchParams(query);
  if (parts.length > 2 || [...filters.keys()].some((key) => key !== "agent_id") || filters.getAll("agent_id").length > 1) return { page: "overview" };
  if (parts.length === 1) {
    const agentID = filters.get("agent_id");
    return agentID ? { page: "audits", agentID } : { page: "audits" };
  }
  try {
    const resourceID = decodeURIComponent(parts[1]!);
    return resourceID ? { page: "audits", resourceID } : { page: "overview" };
  } catch {
    return { page: "overview" };
  }
}
