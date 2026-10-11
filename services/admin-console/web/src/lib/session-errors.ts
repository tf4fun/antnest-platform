export function invalidatesBrowserSession(path: string, status: number, _code?: string): boolean {
  return status === 401 && (path.startsWith("/api/admin/") || path === "/api/session" ||
    /^\/api\/session\/(account|password|activity|sessions|external-identities)(\/|\?|$)/.test(path));
}
