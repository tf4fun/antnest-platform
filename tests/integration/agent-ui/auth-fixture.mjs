import { createAuthFixture } from "../../../services/agent-ui/web/server/test/support/auth-fixture.mjs";
import { createBrowserSessionFixture } from "../../support/agent-ui/browser-session-fixture.mjs";
const fixture = await createAuthFixture({ built: true });
export const {
  authentication: testAuthentication,
  securityEnvironment: testSecurityEnvironment,
  context: testContext,
  jwks: testJwks,
  workloadHeaders,
  headers: testHeaders,
  scope: testScope,
  Request: TestRequest,
  fetch: testFetch,
  createWorkspaceHttpServer: createTestWorkspaceHttpServer,
  startWorkspaceService: startTestWorkspaceService,
  directory: testCredentialDirectory,
} = fixture;

// Isolated browser components stand in for Gateway credential injection. Real
// Gateway/browser integration remains the final cross-service delivery batch.
export async function testBrowserContext(browser, options = {}) {
  const context = await browser.newContext(options);
  const identity = new Headers(options.extraHTTPHeaders);
  const session = createBrowserSessionFixture({
    user_id: identity.get("x-antnest-principal-id") ?? "user-1",
    organization_id: identity.get("x-antnest-organization-id") ?? "org-1",
    membership_id: identity.get("x-antnest-membership-id") ?? "membership-1",
    organization_slug: identity.has("x-antnest-organization-slug")
      ? Buffer.from(
          identity.get("x-antnest-organization-slug"),
          "base64url",
        ).toString("utf8")
      : "engineering",
    organization_name: identity.has("x-antnest-organization-name")
      ? Buffer.from(
          identity.get("x-antnest-organization-name"),
          "base64url",
        ).toString("utf8")
      : "Engineering",
    system_role:
      identity.get("x-antnest-administrator") === "true" ? "admin" : "user",
  });
  const visitedOrigins = new Set();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest() && !visitedOrigins.has(url.origin)) {
      visitedOrigins.add(url.origin);
      const cookies = await context.cookies(url.origin);
      if (
        !cookies.some((cookie) =>
          ["__Host-antnest_csrf", "antnest_csrf"].includes(cookie.name),
        )
      )
        await context.addCookies([
          { name: "antnest_csrf", value: "browser-csrf", url: url.origin },
        ]);
    }
    if (
      (url.pathname === "/api/session" && request.method() === "GET") ||
      (url.pathname === "/api/session/activity" && request.method() === "POST")
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify(
          request.method() === "GET" ? session.read() : session.activity(),
        ),
      });
      return;
    }
    const headers = new Headers(request.headers());
    headers.delete("x-antnest-agent-id");
    const path = url.pathname;
    const match = /^\/api\/app\/workspace\/v1\/agents\/([^/]+)\//u.exec(path);
    if (match && match[1] !== "assets")
      headers.set("x-antnest-agent-id", decodeURIComponent(match[1]));
    headers.delete("antnest-caller-context");
    await route.continue({
      headers: fixture.headers(headers, "edge-gateway", route.request().url()),
    });
  });
  return context;
}
