import assert from "node:assert/strict";

export function fakeClient({
  mutateSession,
  mutateMetadata,
  keepToken = false,
  secureCookies = true,
  cookiePrefix = secureCookies ? "__Host-" : "",
  logoutStatus = 204,
  logoutCode = "unauthenticated",
} = {}) {
  const principal = {
    active: true,
    system_role: "admin",
    user_id: "user",
    organization_id: "org",
    organization_slug: "stage3",
    organization_name: "Stage 3",
    membership_id: "membership",
    organization_role: "admin",
  };
  const metadata = {
    expires_at: new Date(Date.now() + 60000).toISOString(),
    idle_expires_at: new Date(Date.now() + 30000).toISOString(),
    activity_interval_ms: 10000,
  };
  const sessionName = `${cookiePrefix}antnest_session`;
  const csrfName = `${cookiePrefix}antnest_csrf`;
  return {
    cookies: new Map(),
    calls: [],
    revoked: false,
    get cookie() {
      return [...this.cookies]
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
    },
    async request(path, options = {}) {
      const method = options.method ?? (options.body ? "POST" : "GET");
      this.calls.push({ path, method });
      const headers = new Headers({ "cache-control": "no-store" });
      if (path === "/api/session/login") {
        for (const name of [sessionName, csrfName]) {
          this.cookies.set(
            name,
            name === sessionName ? "original-token" : "original-csrf",
          );
          headers.append(
            "set-cookie",
            `${name}=${this.cookies.get(name)}; Path=/; ${secureCookies ? "Secure; " : ""}SameSite=Lax${name === sessionName ? "; HttpOnly" : ""}`,
          );
        }
        const body = { principal, ...metadata };
        mutateMetadata?.(body, "login");
        return {
          body,
          headers,
          traceID: "a".repeat(32),
        };
      }
      if (method === "DELETE") {
        assert.equal(
          this.cookies.get(sessionName),
          "original-token",
          "must revoke the original login",
        );
        assert.equal(this.cookies.get(csrfName), "original-csrf");
        const accepted = Array.isArray(options.status)
          ? options.status
          : [options.status];
        assert(
          accepted.includes(logoutStatus),
          `unexpected logout status ${logoutStatus}`,
        );
        this.revoked = !keepToken;
        this.cookies.clear();
        for (const name of [sessionName, csrfName])
          headers.append("set-cookie", `${name}=; Path=/; Max-Age=0`);
        return {
          status: logoutStatus,
          body: logoutStatus === 401 ? { code: logoutCode } : null,
          headers,
        };
      }
      if (options.status === 401) {
        assert(
          options.headers.Cookie.includes(`${sessionName}=original-token`),
        );
        assert(this.revoked, "old token still resolves");
        return { body: { error: "unauthenticated" }, headers };
      }
      if (mutateSession) {
        this.cookies.set(
          sessionName,
          mutateSession === "clear" ? "" : "replacement-token",
        );
        if (mutateSession === "clear") this.cookies.clear();
        headers.append("set-cookie", `${sessionName}=changed; Path=/`);
      }
      const body = { principal, ...metadata };
      mutateMetadata?.(body, "session");
      return { body, headers, traceID: "b".repeat(32) };
    },
  };
}
