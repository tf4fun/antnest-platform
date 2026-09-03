import type { Session } from "./types";

export function sessionDestination(session: Session, returnTo: string | null): string | undefined {
  if (returnTo === "/workspace/") return returnTo;
  const administrator = session.principal.system_role === "admin" || session.principal.organization_role === "admin";
  return administrator ? undefined : "/workspace/";
}
