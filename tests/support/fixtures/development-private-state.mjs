import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// HTTP adapter evidence only; the deployed Development gate uses real Identity
// and ACP services. Both adapters require the original login and workload grant.
export function developmentPrivateStateFixture(root, { agentId, state }) {
  const credentials = join(root, "private-credentials");
  for (const [path, value] of [
    ["edge-gateway/tokens/identity-service", "G"],
    ["agent-ui/tokens/agent-acp-service", "W"],
  ]) {
    mkdirSync(join(credentials, path, ".."), { recursive: true });
    writeFileSync(join(credentials, path), value.repeat(43), { mode: 0o600 });
  }
  const f = {
    principal: {
      organization_id: "fixture-organization",
      user_id: "fixture-owner",
    },
    session: "fixture-original-session-token",
    context: "fixture-issued-workspace-context",
    identityPrincipal: undefined,
    calls: [],
    failures: [],
    configuration(origin) {
      return {
        credentials,
        acp: origin,
        identity: origin,
        otlp: origin + "/v1/traces",
      };
    },
    login(response) {
      response.setHeader("set-cookie", [
        `antnest_session=${f.session}; Path=/; HttpOnly`,
        "antnest_csrf=fixture-csrf; Path=/; SameSite=Lax",
      ]);
      return { principal: f.principal };
    },
    handle(request, response, body) {
      const path = request.url;
      if (
        ![
          "/rpc/identity/resolve-access-token",
          "/rpc/agent-acp/get-agent-execution-state",
          "/v1/traces",
        ].includes(path) &&
        !/^\/api\/app\/agents\/[^/]+\/state$/u.test(path)
      )
        return false;
      f.calls.push({
        path,
        method: request.method,
        headers: request.headers,
        body,
      });
      try {
        if (path.startsWith("/api/app/")) {
          response
            .writeHead(404, { "content-type": "application/json" })
            .end("{}");
          return true;
        }
        assert.equal(request.method, "POST");
        if (path === "/v1/traces") {
          response
            .writeHead(200, { "content-type": "application/json" })
            .end("{}");
          return true;
        }
        assert.match(
          request.headers.traceparent,
          /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u,
        );
        let value;
        if (path === "/rpc/identity/resolve-access-token") {
          assert.equal(
            request.headers["antnest-service-authorization"],
            "Bearer " + "G".repeat(43),
          );
          assert.deepEqual(JSON.parse(body), {
            access_token: f.session,
            profile: "workspace",
            agent_id: agentId(),
          });
          value = {
            caller_context: f.context,
            principal: f.identityPrincipal ?? f.principal,
          };
        } else {
          assert.equal(
            request.headers["antnest-service-authorization"],
            "Bearer " + "W".repeat(43),
          );
          assert.equal(request.headers["antnest-caller-context"], f.context);
          assert.deepEqual(JSON.parse(body), {});
          value = state();
        }
        response
          .writeHead(200, {
            "content-type": "application/json",
            "x-antnest-trace-id": request.headers.traceparent.split("-")[1],
          })
          .end(JSON.stringify(value));
      } catch (error) {
        f.failures.push(error);
        response
          .writeHead(500, { "content-type": "application/json" })
          .end('{"code":"fixture_assertion"}');
      }
      return true;
    },
  };
  return f;
}
