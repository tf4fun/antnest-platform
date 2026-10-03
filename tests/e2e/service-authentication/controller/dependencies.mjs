// Owning-service doubles; no cross-service business completion is claimed.
import { createServer } from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync("/run/auth/fixture.json", "utf8"));
const key = createPublicKey({ key: fixture.jwks.keys[0], format: "jwk" });
const stats = { calls: {}, failures: 0, registryContexts: [] };
const servers = [];
const json = (w, value, status = 200) => {
  w.writeHead(status, { "content-type": "application/json" });
  w.end(JSON.stringify(value));
};
for (const [service, port] of Object.entries(fixture.ports)) {
  const server = createServer(async (r, w) => {
    try {
      const path = new URL(r.url, "http://fixture").pathname;
      if (path === "/status" || path === "/test/state") return json(w, stats);
      const credential = r.headers["antnest-service-authorization"];
      if (
        !credential?.startsWith("Bearer ") ||
        !fixture.hashes[service].includes(
          createHash("sha256").update(credential.slice(7)).digest("hex"),
        )
      )
        throw Error("invalid_workload");
      if (
        r.headers.authorization ||
        r.headers.cookie ||
        Object.keys(r.headers).some((h) => h.startsWith("x-antnest-"))
      )
        throw Error("untrusted_headers_forwarded");
      stats.calls[service] = (stats.calls[service] ?? 0) + 1;
      let raw = "";
      for await (const part of r) {
        raw += part;
        if (raw.length > 2 ** 24) throw Error("body_limit");
      }
      const body = raw ? JSON.parse(raw) : {};
      if (service === "identity-service") {
        if (path === "/rpc/identity/jwks") return json(w, fixture.jwks);
        if (path === "/rpc/identity/list-principal-revocations")
          return json(w, { events: [], next_sequence: body.after_sequence });
        if (path === "/rpc/identity/resolve-owner-authorization")
          return json(w, {
            authorization: {
              user_id: body.user_id,
              organization_id: body.organization_id,
              membership_id: "member-1",
              active: true,
              last_revocation_sequence: 0,
            },
          });
      }
      if (service === "runtime-controller") {
        if (path === "/internal/runtimes") return json(w, { runtimes: [] });
        if (path === "/internal/runtime-observations")
          return json(w, {
            observations: [],
            oldest_sequence: 0,
            latest_sequence: 0,
            next_sequence: 0,
          });
      }
      if (
        service === "agent-acp-service" &&
        path === "/rpc/agent-acp/apply-execution-snapshot"
      ) {
        if (r.headers["antnest-caller-context"])
          throw Error("user_context_replayed_into_operation");
        return json(w, {
          organization_id: body.organization_id,
          applied_revision: body.revision,
        });
      }
      if (
        service === "skill-registry" &&
        path === "/internal/skill-versions/resolve"
      ) {
        const token = r.headers["antnest-caller-context"],
          parts = token?.split(".");
        if (
          parts?.length !== 3 ||
          !verify(
            null,
            Buffer.from(parts[0] + "." + parts[1]),
            key,
            Buffer.from(parts[2], "base64url"),
          )
        )
          throw Error("cct_invalid");
        const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
        if (
          !claims.aud.includes(service) ||
          claims.org !== body.organization_id ||
          claims.sub !== "user-admin"
        )
          throw Error("cct_scope");
        stats.registryContexts.push(
          createHash("sha256").update(token).digest("hex"),
        );
        return json(w, {
          items: body.refs.map((ref) => {
            if (ref.skill_id !== fixture.skill.skill_id || ref.version !== 1)
              throw Error("skill_ref");
            return fixture.skill;
          }),
        });
      }
      return json(
        w,
        {
          code: "fixture_dependency_unavailable",
          message: "Intentional isolated dependency rejection",
          retryable: true,
        },
        503,
      );
    } catch {
      stats.failures++;
      json(w, { code: "fixture_boundary_failed" }, 503);
    }
  });
  server.listen(port, "0.0.0.0");
  servers.push(server);
}
function stop() {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
