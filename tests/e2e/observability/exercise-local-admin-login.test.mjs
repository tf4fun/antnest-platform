import assert from "node:assert/strict";
import test from "node:test";
import { exerciseLocalAdminLogin } from "./exercise-local-admin-login.mjs";

function fakeClient({
  mutateSession,
  keepToken = false,
  secureCookies = true,
  cookiePrefix = secureCookies ? "__Host-" : "",
} = {}) {
  const principal = { active: true, system_role: "admin", user_id: "user" };
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
        return {
          body: {
            principal,
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
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
        this.revoked = !keepToken;
        this.cookies.clear();
        return { body: null, headers };
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
      return { body: { principal }, headers, traceID: "b".repeat(32) };
    },
  };
}

for (const secureCookies of [true, false])
  test(`login exercise revokes and replays the original ${secureCookies ? "Secure" : "insecure"} session`, async () => {
    const client = fakeClient({ secureCookies });
    const result = await exerciseLocalAdminLogin({
      client,
      secureCookies,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => ({}),
    });
    assert(result.cleanup_revoked);
    assert.equal(client.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(client.calls.filter((c) => c.method === "DELETE").length, 1);
    assert.equal(client.calls.filter((c) => c.method === "GET").length, 2);
    assert.equal(client.cookie, "");
  });

test("Secure admission rejects legacy names and still cleans the original token", async () => {
  const client = fakeClient({ cookiePrefix: "" });
  await assert.rejects(
    exerciseLocalAdminLogin({
      client,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => ({}),
    }),
    /missing session cookie/u,
  );
  assert(client.revoked);
});

for (const mutateSession of ["clear", "replace"])
  test(`unexpected ${mutateSession} Cookie still cleans original token`, async () => {
    const client = fakeClient({ mutateSession });
    await assert.rejects(
      exerciseLocalAdminLogin({
        client,
        settings: {},
        jaeger: "http://jaeger",
      }),
    );
    assert(client.revoked);
    assert.equal(client.cookie, "");
  });

test("clearing Cookie without token revocation cannot report success", async () => {
  const client = fakeClient({ keepToken: true });
  await assert.rejects(
    exerciseLocalAdminLogin({
      client,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => ({}),
    }),
    /old token still resolves/u,
  );
});

test("trace failure still revokes the original session", async () => {
  const client = fakeClient();
  await assert.rejects(
    exerciseLocalAdminLogin({
      client,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => {
        throw new Error("trace unavailable");
      },
    }),
    /trace unavailable/u,
  );
  assert(client.revoked);
});
