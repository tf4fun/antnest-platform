export type ConsolePage = "overview" | "directory" | "provisioning" | "models" | "templates" | "agents";

export type ConsoleRoute = { page: ConsolePage; resourceID?: string; revisionID?: string };

export function parseConsoleRoute(hash: string): ConsoleRoute {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const page = parts[0];
  if ((page === "directory" || page === "provisioning") && parts.length === 1) return { page };
  if (page === "models" || page === "templates") {
    if (parts.length === 1) return { page };
    if (parts.length === 2) return { page, resourceID: parts[1] };
    if (page === "templates" && parts.length === 4 && parts[2] === "revisions") {
      const revisionID = parts[3];
      if (!revisionID || !/^\d+$/.test(revisionID)) return { page: "overview" };
      return { page, resourceID: parts[1], revisionID };
    }
    return { page: "overview" };
  }
  if (page === "agents" && parts.length <= 2) return { page, resourceID: parts[1] };
  return { page: "overview" };
}
