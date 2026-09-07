import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { createOIDCProvider } from "./oidc-provider.mjs";

const provider = createOIDCProvider({
  issuer: "https://oidc-fixture:8443",
  callback: process.env.OIDC_TEST_CALLBACK,
});
const denials = createOIDCProvider({
  issuer: "https://oidc-fixture:8443/denials",
  callback: process.env.OIDC_TEST_CALLBACK,
});
const server = createServer(
  { key: readFileSync("/certs/tls.key"), cert: readFileSync("/certs/tls.crt") },
  (request, response) => {
    const target = request.url.startsWith("/denials/") ? denials : provider;
    target.handle(request, response);
  },
);
server.requestTimeout = 15000;
server.listen(8443, "0.0.0.0");
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close();
});
