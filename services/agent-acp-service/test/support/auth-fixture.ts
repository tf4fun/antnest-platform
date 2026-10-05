import { generateKeyPairSync, randomBytes, randomUUID, createHash, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import {
  ServiceAuthentication,
  SERVICES,
  SERVICE_AUTH_HEADER,
} from "../../src/adapters/service-authentication.js";
import {
  CallerContextVerifier,
  CALLER_CONTEXT_HEADER,
  type CallerClaims,
} from "../../src/adapters/caller-context.js";
import { RequestAuthentication } from "../../src/transport/request-authentication.js";

const directory = mkdtempSync(join(tmpdir(), "antnest-acp-auth-test-"));
const callerTokens = new Map(
  SERVICES.filter((service) => service !== "agent-acp-service").map((service) => [
    service,
    randomBytes(32).toString("base64url"),
  ]),
);
mkdirSync(join(directory, "tokens"), { mode: 0o700 });
const hashes = Object.fromEntries(
  [...callerTokens].map(([service, token]) => [
    service,
    [`sha256:${createHash("sha256").update(token).digest("hex")}`],
  ]),
);
writeFileSync(join(directory, "callers.json"), JSON.stringify(hashes), { mode: 0o600 });
for (const service of SERVICES.filter((value) => value !== "agent-acp-service"))
  writeFileSync(join(directory, "tokens", service), randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });
const pair = generateKeyPairSync("ed25519");
const jwks = {
  keys: [
    { ...pair.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "EdDSA", use: "sig" },
  ],
};
export function testJwks() {
  return jwks;
}
const workloads: ServiceAuthentication[] = [];
afterAll(async () => {
  await Promise.all(workloads.map((workload) => workload.close()));
  rmSync(directory, { recursive: true, force: true });
});

export function testSecurityEnvironment() {
  return {
    ANTNEST_SERVICE_AUTH_MODE: "token",
    ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "true",
    ANTNEST_SERVICE_AUTH_CALLERS_FILE: join(directory, "callers.json"),
    ANTNEST_SERVICE_AUTH_TOKEN_DIR: join(directory, "tokens"),
    ANTNEST_ACP_IDENTITY_URL: "http://identity.invalid/",
  };
}
export function testAuthentication() {
  const workload = new ServiceAuthentication(testSecurityEnvironment());
  workloads.push(workload);
  const verifier = new CallerContextVerifier("http://identity.invalid/", () =>
    Promise.resolve(Response.json(jwks)),
  );
  return new RequestAuthentication(workload, verifier);
}
export function workloadHeaders(caller: string) {
  return { [SERVICE_AUTH_HEADER]: `Bearer ${callerTokens.get(caller)!}` };
}
export function signContext(overrides: Partial<CallerClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: CallerClaims = {
    iss: "antnest://service/identity-service",
    sub: "principal-1",
    org: "organization-1",
    mbr: "membership-1",
    sys_role: "user",
    org_role: "member",
    sid: "session-auth-1",
    aud: ["agent-acp-service"],
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    ...overrides,
  };
  const payload = `${Buffer.from(JSON.stringify({ typ: "antnest-cct+jwt", alg: "EdDSA", kid: "test-key" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString("base64url")}`;
}
// Business tests explicitly turn their fixture identity into signed credentials.
// Security tests use raw headers instead; production never accepts these hints.
export function testHeaders(
  hints: Record<string, string> = {},
  caller = "edge-gateway",
): Record<string, string> {
  const lower = Object.fromEntries(
    Object.entries(hints).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ...hints,
    ...workloadHeaders(caller),
    [CALLER_CONTEXT_HEADER]: signContext({
      sub: lower["x-antnest-user-id"] ?? lower["x-antnest-principal-id"] ?? "principal-1",
      org: lower["x-antnest-organization-id"] ?? "organization-1",
      mbr: lower["x-antnest-membership-id"] ?? "membership-1",
      sys_role: (lower["x-antnest-system-role"] as CallerClaims["sys_role"] | undefined) ?? "user",
      org_role:
        (lower["x-antnest-organization-role"] as CallerClaims["org_role"] | undefined) ?? "member",
      ...(lower["x-antnest-agent-id"] === undefined ? {} : { agt: lower["x-antnest-agent-id"] }),
    }),
  };
}
