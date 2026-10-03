import { createAuthFixture } from "../../../services/agent-ui/web/server/test/support/auth-fixture.mjs";
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
  await context.route("**/*", async (route) => {
    const headers = new Headers(route.request().headers());
    headers.delete("x-antnest-agent-id");
    const path = new URL(route.request().url()).pathname;
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
