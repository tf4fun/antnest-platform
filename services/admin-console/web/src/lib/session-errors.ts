export function invalidatesBrowserSession(path: string, status: number, code?: string): boolean {
  const credentialRejected = path === "/api/admin/account/password" && code === "invalid_current_password";
  return status === 401 && path.startsWith("/api/admin/") && !credentialRejected;
}
