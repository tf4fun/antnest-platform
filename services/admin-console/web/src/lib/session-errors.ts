const authenticatedCommandFailures = new Set(["/api/admin/account/password"]);

export function invalidatesBrowserSession(path: string, status: number): boolean {
  return status === 401 && path.startsWith("/api/admin/") && !authenticatedCommandFailures.has(path);
}
