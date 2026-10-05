// Owning-service doubles; final cross-service acceptance remains separate.
import { createServer } from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("/run/auth/fixture.json", "utf8"));
const publicKey = createPublicKey({ key: fixture.jwks.keys[0], format: "jwk" });
const stats = {
  calls: 0,
  preparationCalls: 0,
  opened: 0,
  closed: 0,
  active: 0,
  discovery: [],
};
const servers = [];
const watches = new Set();
function json(w, body, status = 200) {
  w.writeHead(status, { "content-type": "application/json" });
  w.end(JSON.stringify(body));
}
for (const [service, port] of Object.entries(fixture.ports)) {
  const server = createServer(async (r, w) => {
    try {
      const path = new URL(r.url, "http://fixture").pathname;
      if (path === "/status" || path === "/test/state") return json(w, stats);
      const bearer = r.headers["antnest-service-authorization"];
      if (
        !bearer?.startsWith("Bearer ") ||
        !fixture.hashes[service].includes(
          createHash("sha256").update(bearer.slice(7)).digest("hex"),
        )
      )
        return json(w, { code: "service_unauthenticated" }, 401);
      if (r.headers.authorization || r.headers.cookie)
        throw Error("browser_credential_leaked");
      if (service === "identity-service" && path === "/rpc/identity/jwks")
        return json(w, fixture.jwks);
      const token = r.headers["antnest-caller-context"];
      const parts = token?.split(".");
      if (
        parts?.length !== 3 ||
        !verify(
          null,
          Buffer.from(`${parts[0]}.${parts[1]}`),
          publicKey,
          Buffer.from(parts[2], "base64url"),
        )
      )
        throw Error("caller_context_invalid");
      const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
      if (!claims.aud.includes(service) || claims.sub !== "user-admin")
        throw Error("caller_scope_invalid");
      stats.calls++;
      let raw = "";
      for await (const part of r) {
        raw += part;
        if (raw.length > 65536) throw Error("body_too_large");
      }
      const body = raw ? JSON.parse(raw) : {};
      for (const field of ["organization_id"])
        if (body[field] !== undefined && body[field] !== claims.org)
          throw Error("organization_not_signed");
      for (const field of ["actor_principal_id", "actor_id"])
        if (body[field] !== undefined && body[field] !== claims.sub)
          throw Error("actor_not_signed");
      if (service === "identity-service") {
        if (path.endsWith("list-directory"))
          return json(w, { users: [], groups: [] });
        if (path.endsWith("get-current-account"))
          return json(w, {
            account: {
              email: "admin@example.test",
              display_name: "Administrator",
            },
          });
        if (path.endsWith("change-local-password"))
          return json(w, { status: "changed" });
      }
      if (service === "agent-controller") {
        if (
          path === "/internal/provider-discovery/draft" ||
          /^\/internal\/provider-connections\/[^/]+\/discover-models$/u.test(
            path,
          )
        ) {
          if (r.method !== "POST" || new URL(r.url, "http://fixture").search)
            throw Error("discovery_contract_invalid");
          const draft = path === "/internal/provider-discovery/draft";
          if (!draft && Object.keys(body).length !== 1)
            throw Error("saved_discovery_must_not_read_credentials");
          stats.discovery.push({
            path,
            organization: body.organization_id,
            contextDigest: createHash("sha256").update(token).digest("hex"),
            ...(draft
              ? {
                  credentialDigest: createHash("sha256")
                    .update(body.credential.api_key)
                    .digest("hex"),
                }
              : {}),
          });
          const outcome = draft
            ? new URL(body.base_url).pathname.split("/").at(-1)
            : path.split("/").at(-2);
          const failures = {
            forbidden: [422, "provider_endpoint_forbidden"],
            unavailable: [503, "provider_endpoint_unavailable"],
            failed: [502, "provider_discovery_failed"],
            missing: [404, "reference_not_found"],
            disabled: [409, "reference_disabled"],
          };
          if (failures[outcome]) {
            const [status, code] = failures[outcome];
            return json(
              w,
              {
                code,
                message: "synthetic-provider-secret at http://private/v1",
                api_key: "synthetic-provider-secret",
                retryable: status >= 500,
              },
              status,
            );
          }
          if (outcome === "empty") return json(w, { models: [] });
          return json(w, {
            models: [
              {
                model_id: "remote",
                display_name: "Remote",
                supports_images: false,
                context_window: 128000,
                api_key: "synthetic-provider-secret",
              },
            ],
            credential: { api_key: "synthetic-provider-secret" },
          });
        }
        if (path.startsWith("/internal/agent-skill-preparations/")) {
          stats.preparationCalls++;
          const query = new URL(r.url, "http://fixture").searchParams;
          if (query.get("organization_id") !== claims.org)
            throw Error("query_scope_not_signed");
          const preparation = Object.values(fixture.preparations).find((item) =>
            path.endsWith("/" + item.request_id),
          );
          if (!preparation || claims.org !== "org-1")
            return json(
              w,
              {
                code: "preparation_not_found",
                message: "Skill preparation was not found",
                retryable: false,
              },
              404,
            );
          return json(w, {
            request_id: preparation.request_id,
            agent_id: "agent-1",
            kind: preparation.kind,
            state: "retry_wait",
            progress: {
              verified_packages: 1,
              verified_bytes: 128,
              total_packages: 2,
              total_bytes: 256,
            },
            updated_at: "2026-09-27T12:00:00Z",
            target_spec: { system_prompt: "secret" },
            prepared_reference_id: "secret",
          });
        }
        if (path === "/internal/agents")
          return json(w, { items: [], next_cursor: null });
        if (path === "/internal/agents/agent-1/events/watch") {
          if (claims.agt !== "agent-1") throw Error("agent_not_signed");
          stats.opened++;
          stats.active++;
          watches.add(w);
          w.once("close", () => {
            stats.closed++;
            stats.active--;
            watches.delete(w);
          });
          w.writeHead(200, { "content-type": "text/event-stream" });
          w.flushHeaders();
          return;
        }
      }
      if (
        service === "agent-acp-service" &&
        path.endsWith("list-execution-audits")
      )
        return json(w, { items: [], next_cursor: null });
      if (service === "skill-registry") {
        if (path === "/internal/skills")
          return json(w, { items: [], next_after_id: null });
        if (path === "/internal/skill-discovery/search")
          return json(w, { items: [] });
      }
      return json(w, { code: "unexpected_route" }, 404);
    } catch {
      json(w, { code: "fixture_boundary_failed" }, 503);
    }
  });
  server.listen(port, "0.0.0.0");
  servers.push(server);
}
function stop() {
  for (const response of watches) response.end();
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
