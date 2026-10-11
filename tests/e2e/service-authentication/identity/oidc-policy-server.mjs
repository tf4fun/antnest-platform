import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { createOIDCProvider } from "./oidc-provider.mjs";

const origin = "https://oidc-fixture:8443";
const providers = new Map(
  [
    "policy",
    "mismatch",
    "fallback",
    "bindings",
    "scim-pairing-a",
    "scim-pairing-b",
  ].map((name) => [
    name,
    {
      provider: createOIDCProvider({
        issuer: `${origin}/${name}`,
        callback: "http://127.0.0.1/protocol/oidc/callback",
        userInfo: true,
      }),
      userInfoRequests: 0,
    },
  ]),
);
const json = (response, status, value) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};
const server = createServer(
  { key: readFileSync("/certs/tls.key"), cert: readFileSync("/certs/tls.crt") },
  (request, response) => {
    const path = new URL(request.url, origin).pathname;
    if (path === "/status") return json(response, 200, { status: "ready" });
    const name = path.split("/")[1];
    const fixture = providers.get(name);
    if (!fixture) return json(response, 404, { error: "not_found" });
    if (path === `/${name}/fixture/fault-stats`)
      return json(response, 200, {
        userInfoRequests: fixture.userInfoRequests,
      });
    if (path === `/${name}/userinfo`) {
      fixture.userInfoRequests++;
      if (name === "policy")
        return json(response, 503, { error: "fixture_unavailable" });
      if (name === "mismatch")
        return json(response, 200, {
          sub: "different-subject",
          email: "oidc-local@example.com",
          email_verified: true,
        });
    }
    fixture.provider.handle(request, response);
  },
);
server.requestTimeout = 15000;
server.listen(8443, "0.0.0.0");
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close();
});
