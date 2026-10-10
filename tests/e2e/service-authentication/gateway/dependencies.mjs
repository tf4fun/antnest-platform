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
  session: ["identity-service"],
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
const sessions = new Map();
const revocations = [];
let password = fixture.password;
function metadata(session) {
  return {
    expires_at: session.expires_at,
    idle_expires_at: session.idle_expires_at,
    activity_interval_ms: 30000,
  };
}
function issue(hint, previous) {
  const now = Date.now();
  const session = {
    token_id: `session-${sessions.size + 1}`,
    id: `public-${randomUUID()}`,
    access_token: sessions.size === 0 ? fixture.access : randomUUID(),
    created_at: new Date(now).toISOString(),
    last_active_at: new Date(now).toISOString(),
    expires_at: previous?.expires_at ?? new Date(now + 3600000).toISOString(),
    idle_expires_at: new Date(
      Math.min(
        now + 300000,
        previous ? Date.parse(previous.expires_at) : Infinity,
      ),
    ).toISOString(),
    user_agent_hint: hint ?? "",
    revoked: false,
  };
  sessions.set(session.access_token, session);
  return session;
}
function live(session) {
  return (
    session &&
    !session.revoked &&
    Date.parse(session.expires_at) > Date.now() &&
    Date.parse(session.idle_expires_at) > Date.now()
  );
}
function credential(session) {
  return {
    principal,
    token_id: session.token_id,
    access_token: session.access_token,
    ...metadata(session),
  };
}
function revoke(session, reason = "session_revoked") {
  if (!live(session)) return false;
  session.revoked = true;
  revocations.push({
    sequence: revocations.length + 1,
    token_id: session.token_id,
    user_id: principal.user_id,
    organization_id: principal.organization_id,
    reason,
    occurred_at: new Date().toISOString(),
  });
  return true;
}
function cct(profile, agent, session) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "antnest://service/identity-service",
    sub: principal.user_id,
    org: principal.organization_id,
    mbr: principal.membership_id,
    sys_role: "admin",
    org_role: "admin",
    sid: session.token_id,
    aud: profiles[profile],
    iat: now,
    exp: Math.min(
      now + 60,
      Math.floor(Date.parse(session.idle_expires_at) / 1000),
      Math.floor(Date.parse(session.expires_at) / 1000),
    ),
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
  if (
    !live(
      [...sessions.values()].find((session) => session.token_id === claims.sid),
    )
  )
    throw Error("caller_context_invalid");
  return claims;
}

function browserControl(request, input) {
  const claims = context(request, "identity-service");
  if (
    claims.aud.length !== 1 ||
    claims.agt !== undefined ||
    input.actor_principal_id !== claims.sub ||
    (input.user_id !== undefined && input.user_id !== claims.sub) ||
    (input.scope !== undefined && input.scope !== "self")
  )
    throw Error("browser_control_scope_invalid");
  return [...sessions.values()].find(
    (session) => session.token_id === claims.sid,
  );
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
        if (
          [
            "local-login",
            "resolve-access-token",
            "revoke-access-token",
            "list-session-revocations",
          ].some((method) => path.endsWith(method)) &&
          headerValues(request, "Antnest-Caller-Context").length
        )
          throw Error("workload_operation_received_browser_context");
        if (path.endsWith("local-login")) {
          if (input.password !== password)
            return json(response, { code: "unauthenticated" }, 401);
          return json(response, credential(issue(input.user_agent_hint)));
        }
        if (path.endsWith("resolve-access-token")) {
          const session = sessions.get(input.access_token);
          if (
            !live(session) ||
            !profiles[input.profile] ||
            (input.profile === "session" && input.agent_id)
          )
            return json(response, { code: "unauthenticated" }, 401);
          return json(response, {
            principal,
            caller_context: cct(input.profile, input.agent_id, session),
            ...metadata(session),
          });
        }
        if (path.endsWith("revoke-access-token")) {
          return json(response, {
            status: revoke(sessions.get(input.access_token))
              ? "revoked"
              : "already_invalid",
          });
        }
        if (path.endsWith("list-session-revocations")) {
          if (
            !Number.isSafeInteger(input.after_sequence) ||
            input.after_sequence < 0 ||
            input.limit < 1 ||
            input.limit > 500
          )
            throw Error("invalid_feed_request");
          const events = revocations
            .filter((event) => event.sequence > input.after_sequence)
            .slice(0, input.limit);
          return json(response, {
            events,
            next_sequence: events.at(-1)?.sequence ?? input.after_sequence,
          });
        }
        const current = browserControl(request, input);
        if (path.endsWith("get-current-account")) {
          if (input.organization_id !== principal.organization_id)
            throw Error("invalid_account_scope");
          return json(response, {
            account: {
              ...principal,
              email: "admin@example.test",
              display_name: "Test Admin",
              source: "local",
              local_password_available: true,
            },
          });
        }
        if (path.endsWith("touch-browser-session")) {
          current.last_active_at = new Date().toISOString();
          current.idle_expires_at = new Date(
            Math.min(Date.now() + 300000, Date.parse(current.expires_at)),
          ).toISOString();
          return json(response, metadata(current));
        }
        if (path.endsWith("list-user-sessions")) {
          if (
            input.scope !== "self" ||
            input.user_id !== principal.user_id ||
            input.limit < 1 ||
            input.limit > 100
          )
            throw Error("invalid_session_scope");
          const rows = [...sessions.values()]
            .filter(live)
            .filter((session) => session.id > (input.after_id ?? ""))
            .sort((a, b) => a.id.localeCompare(b.id));
          const page = rows.slice(0, input.limit).map((session) => ({
            id: session.id,
            organization_id: principal.organization_id,
            organization_slug: principal.organization_slug,
            organization_name: principal.organization_name,
            created_at: session.created_at,
            last_active_at: session.last_active_at,
            expires_at: session.expires_at,
            idle_expires_at: session.idle_expires_at,
            user_agent_hint: session.user_agent_hint,
            current: session === current,
          }));
          return json(response, {
            sessions: page,
            ...(rows.length > input.limit
              ? { next_after_id: page.at(-1).id }
              : {}),
          });
        }
        if (path.endsWith("revoke-user-sessions")) {
          if (
            input.scope !== "self" ||
            input.user_id !== principal.user_id ||
            !["all", "others"].includes(input.mode)
          )
            throw Error("invalid_session_scope");
          let revoked = 0;
          for (const session of sessions.values())
            if (
              (input.mode === "all" || session !== current) &&
              revoke(session)
            )
              revoked++;
          return json(response, {
            revoked_count: revoked,
            current_revoked: current.revoked,
          });
        }
        if (path.endsWith("change-local-password")) {
          if (input.current_password !== password)
            return json(
              response,
              { code: "invalid_current_password", retryable: false },
              400,
            );
          password = input.new_password;
          for (const session of sessions.values())
            revoke(session, "password_changed");
          return json(response, {
            status: "changed",
            ...credential(issue(current.user_agent_hint, current)),
          });
        }
        throw Error("unexpected_identity_route");
      }
      if (request.headers.authorization)
        throw Error("browser_authorization_leaked");
      const publicAsset =
        (service === "admin-console" && path === "/") ||
        (service === "agent-ui" && path.startsWith("/workspace/assets/"));
      response.setHeader(
        "Set-Cookie",
        "antnest_session=upstream-forgery; Path=/",
      );
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
      if (service === "admin-console" && path.endsWith("/events/watch")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: ready\ndata: {}\n\n");
        return;
      }
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
