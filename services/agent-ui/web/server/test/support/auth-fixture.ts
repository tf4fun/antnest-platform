import { createAuthFixture } from "./auth-fixture.mjs";
const fixture = await createAuthFixture();
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
