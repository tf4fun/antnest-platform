import { generateKeyPairSync, randomBytes, randomUUID, createHash, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

// Owning-service tests generate private credentials. Production never reads
// fixture identity hints or this helper's built/source selection.
export async function createAuthFixture({ built = false } = {}) {
  const root = built ? "../../dist/" : "../../src/";
  const extension = built ? "js" : "ts";
  const load = (path) => import(new URL(`${root}${path}.${extension}`, import.meta.url));
  const { ServiceAuthentication, SERVICES, SERVICE_AUTH_HEADER } = await load("adapters/service-authentication");
  const { CallerContextVerifier, CALLER_CONTEXT_HEADER } = await load("adapters/caller-context");
  const { RequestAuthentication } = await load("http/request-authentication");
  const { bindAuthenticatedRequest, bindScopeContext } = await load("http/trusted-identity");
  const { createWorkspaceHttpServer } = await load("http/node-server");
  const { startWorkspaceService } = await load("service-lifecycle");
  const directory = mkdtempSync(join(tmpdir(), "antnest-ui-auth-test-"));
  mkdirSync(join(directory, "tokens"), { mode: 0o700 });
  const callerTokens = new Map(SERVICES.filter((service) => service !== "agent-ui")
    .map((service) => [service, randomBytes(32).toString("base64url")]));
  writeFileSync(join(directory, "callers.json"), JSON.stringify(Object.fromEntries([...callerTokens]
    .map(([service, token]) => [service, [`sha256:${createHash("sha256").update(token).digest("hex")}`]]))), { mode: 0o600 });
  for (const service of callerTokens.keys()) writeFileSync(join(directory, "tokens", service),
    randomBytes(32).toString("base64url"), { mode: 0o600 });
  const pair = generateKeyPairSync("ed25519");
  const jwks = { keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "EdDSA", use: "sig" }] };
  const workloads = [];
  const securityEnvironment = () => ({
    ANTNEST_SERVICE_AUTH_MODE: "token", ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "true",
    ANTNEST_SERVICE_AUTH_CALLERS_FILE: join(directory, "callers.json"),
    ANTNEST_SERVICE_AUTH_TOKEN_DIR: join(directory, "tokens"),
    ANTNEST_AGENT_UI_IDENTITY_URL: "http://identity.invalid/",
  });
  const authentication = () => {
    const workload = new ServiceAuthentication(securityEnvironment()); workloads.push(workload);
    return new RequestAuthentication(workload, new CallerContextVerifier("http://identity.invalid/",
      async () => Response.json(jwks)));
  };
  const context = (overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: "antnest://service/identity-service", sub: "user-1", org: "org-1", mbr: "membership-1",
      sys_role: "user", org_role: "member", sid: "login-1", aud: ["agent-ui", "agent-acp-service", "agent-controller"],
      iat: now, exp: now + 60, jti: randomUUID(), ...overrides };
    const input = `${Buffer.from(JSON.stringify({ typ: "antnest-cct+jwt", alg: "EdDSA", kid: "test-key" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    return { claims, token: `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString("base64url")}` };
  };
  const workloadHeaders = (caller = "edge-gateway") => ({ [SERVICE_AUTH_HEADER]: `Bearer ${callerTokens.get(caller)}` });
  const hintsContext = (headers, url) => {
    const principal = headers.get("x-antnest-principal-id"); const organization = headers.get("x-antnest-organization-id");
    if (principal === null || organization === null) return undefined;
    let agent = headers.get("x-antnest-agent-id");
    if (url && new URL(url).pathname.startsWith("/workspace/")) agent = null;
    return context({ sub: principal, org: organization,
      sys_role: headers.get("x-antnest-administrator") === "true" ? "admin" : "user",
      ...(agent === null ? {} : { agt: agent }) });
  };
  const headers = (hints = {}, caller = "edge-gateway", url) => {
    const result = new Headers(hints);
    for (const [name, value] of Object.entries(workloadHeaders(caller))) result.set(name, value);
    const delegation = hintsContext(result, url);
    if (delegation && !result.has(CALLER_CONTEXT_HEADER)) result.set(CALLER_CONTEXT_HEADER, delegation.token);
    return Object.fromEntries(result);
  };
  class FixtureRequest extends globalThis.Request {
    constructor(input, init) {
      super(input, init);
      const delegation = hintsContext(this.headers, this.url);
      if (delegation) bindAuthenticatedRequest(this, delegation);
    }
  }
  const fetcher = (input, init) => {
    const request = new globalThis.Request(input, init);
    if (hintsContext(request.headers, request.url)) request.headers.delete(CALLER_CONTEXT_HEADER);
    const signed = headers(request.headers, "edge-gateway", request.url);
    return globalThis.fetch(new globalThis.Request(request, { headers: signed }));
  };
  const scope = (value, overrides = {}) => {
    bindScopeContext(value, context({ org: value.organizationId, sub: value.principalId,
      ...(value.agentId === undefined ? {} : { agt: value.agentId }), ...overrides }));
    return value;
  };
  after(async () => { for (const workload of workloads) await workload.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, authentication, securityEnvironment, context, jwks, workloadHeaders, headers, scope,
    Request: FixtureRequest, fetch: fetcher,
    createWorkspaceHttpServer: (runtime, options = {}) => createWorkspaceHttpServer(runtime, { authentication: authentication(), ...options }),
    startWorkspaceService: (input) => startWorkspaceService({ authentication: authentication(), ...input }) };
}
