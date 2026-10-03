// Authenticated dependency doubles for Gateway's owning-service Docker batch.
// This is not the final cross-service integration acceptance.
import { createServer } from "node:http";
import {
  createHash,
  createPublicKey,
  sign,
  verify,
  randomUUID,
} from "node:crypto";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("/run/auth/fixture.json", "utf8"));
const privateKey = readFileSync("/run/auth/issuer.pem");
const publicKey = createPublicKey(privateKey);
const principal = {
  user_id: "user-admin",
  organization_id: "organization-1",
  membership_id: "membership-1",
  organization_slug: "auth-test",
  organization_name: "Authentication Test",
  system_role: "admin",
  organization_role: "admin",
  active: true,
};
const profiles = {
  console: [
    "admin-console",
    "identity-service",
    "agent-controller",
    "skill-registry",
    "agent-acp-service",
  ],
  workspace: ["agent-ui", "agent-acp-service", "agent-controller"],
  acp: ["agent-acp-service"],
};
function cct(profile, agent) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "antnest://service/identity-service",
    sub: principal.user_id,
    org: principal.organization_id,
    mbr: principal.membership_id,
    sys_role: "admin",
    org_role: "admin",
    sid: "session-1",
    aud: profiles[profile],
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    ...(agent ? { agt: agent } : {}),
  };
  const content =
    Buffer.from(
      JSON.stringify({ typ: "antnest-cct+jwt", alg: "EdDSA", kid: "test" }),
    ).toString("base64url") +
    "." +
    Buffer.from(JSON.stringify(claims)).toString("base64url");
  return (
    content +
    "." +
    sign(null, Buffer.from(content), privateKey).toString("base64url")
  );
}
function headerValues(request, wanted) {
  const values = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i].toLowerCase() === wanted.toLowerCase())
      values.push(request.rawHeaders[i + 1]);
  return values;
}
function authenticate(request, service) {
  const values = headerValues(request, "Antnest-Service-Authorization");
  if (values.length !== 1 || !values[0].startsWith("Bearer ")) return false;
  const digest = createHash("sha256").update(values[0].slice(7)).digest("hex");
  return fixture.hashes[service].includes(digest);
}
function context(request, service, agent) {
  const values = headerValues(request, "Antnest-Caller-Context");
  if (values.length !== 1) throw Error("caller_context_required");
  const [header, payload, signature] = values[0].split(".");
  if (
    !verify(
      null,
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    )
  )
    throw Error("caller_context_invalid");
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  if (
    !claims.aud.includes(service) ||
    claims.sub !== principal.user_id ||
    claims.org !== principal.organization_id ||
    claims.exp <= Date.now() / 1000 ||
    (agent !== undefined && claims.agt !== agent)
  )
    throw Error("caller_context_invalid");
  return claims;
}
function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
for (const [service, port] of Object.entries(fixture.ports)) {
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/status") return json(response, { status: "ready" });
      if (!authenticate(request, service))
        return json(response, { code: "service_unauthenticated" }, 401);
      if (
        request.headers["x-antnest-future-privilege"] ||
        request.headers["x-antnest-csrf-token"] ||
        request.headers.cookie
      )
        throw Error("browser_credential_leaked");
      const path = new URL(request.url, "http://fixture").pathname;
      let body = "";
      for await (const part of request) {
        body += part;
        if (body.length > 65536) throw Error("body_too_large");
      }
      if (service === "identity-service") {
        if (path.startsWith("/scim/")) {
          if (
            request.headers.authorization !== `Bearer ${fixture.scim}` ||
            headerValues(request, "Antnest-Caller-Context").length
          )
            throw Error("SCIM_boundary_failed");
          response.setHeader(
            "Antnest-Service-Authorization",
            "upstream-secret",
          );
          response.setHeader("Antnest-Caller-Context", "upstream-context");
          return json(response, { scim: true });
        }
        const input = JSON.parse(body);
        if (path.endsWith("local-login")) {
          if (input.password !== fixture.password)
            return json(response, { code: "unauthenticated" }, 401);
          return json(response, {
            principal,
            token_id: "session-1",
            access_token: fixture.access,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          });
        }
        if (path.endsWith("resolve-access-token")) {
          if (input.access_token !== fixture.access || !profiles[input.profile])
            return json(response, { code: "unauthenticated" }, 401);
          return json(response, {
            principal,
            caller_context: cct(input.profile, input.agent_id),
          });
        }
        if (path.endsWith("revoke-access-token"))
          return json(response, { status: "revoked" });
        throw Error("unexpected_identity_route");
      }
      if (request.headers.authorization)
        throw Error("browser_authorization_leaked");
      const publicAsset =
        (service === "admin-console" && path === "/") ||
        (service === "agent-ui" && path.startsWith("/workspace/assets/"));
      if (publicAsset) {
        if (headerValues(request, "Antnest-Caller-Context").length)
          throw Error("anonymous_context_leaked");
        return json(response, { service, anonymous: true });
      }
      let agent;
      if (service === "agent-ui" && path.includes("/agents/"))
        agent = path.split("/agents/")[1].split("/")[0];
      if (service === "admin-console" && path.startsWith("/api/admin/agents/"))
        agent = path.split("/")[4];
      if (service === "agent-acp-service")
        agent = request.headers["x-antnest-agent-id"];
      const claims = context(request, service, agent);
      const expectedPrincipal = request.headers["x-antnest-expected-principal"];
      if (
        service === "admin-console" &&
        request.method === "PUT" &&
        path.endsWith("/network-policy")
      ) {
        if (
          expectedPrincipal !==
          encodeURIComponent(JSON.stringify([claims.org, claims.sub]))
        )
          throw Error("CAS_guard_was_lost");
      } else if (expectedPrincipal !== undefined)
        throw Error("CAS_guard_escaped_its_operation");
      response.setHeader("Antnest-Service-Authorization", "upstream-secret");
      response.setHeader("Antnest-Caller-Context", "upstream-context");
      if (service === "agent-controller")
        return json(response, { agents: [], next_cursor: null });
      if (service === "agent-acp-service" && path.includes("execution-state")) {
        const state = {
          agent_id: agent,
          availability: "ready",
          access_allowed: true,
          configuration_revision: "a".repeat(64),
          active_session_id: null,
          unavailable_reason: null,
        };
        if (!path.includes("watch-")) return json(response, state);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `event: workspace_state\ndata: ${JSON.stringify(state)}\n\n`,
        );
        return;
      }
      return json(response, {
        service,
        audience: claims.aud,
        agent: claims.agt ?? null,
        subject: claims.sub,
      });
    } catch (error) {
      json(response, { code: error.message }, 403);
    }
  });
  server.listen(port, "0.0.0.0");
}
