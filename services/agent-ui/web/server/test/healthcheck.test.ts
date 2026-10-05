import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkReadiness } from "../src/healthcheck.ts";
import { testSecurityEnvironment } from "./support/auth-fixture.ts";

test("health probe uses the configured local port and fails on non-ready responses", async () => {
  let status = 200;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/status"); response.writeHead(status).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const env = { ...testSecurityEnvironment(), ANTNEST_AGENT_UI_BRIDGE_PORT: String(address.port) };
    assert.equal(await checkReadiness(env), true); status = 503;
    assert.equal(await checkReadiness(env), false);
    assert.equal(await checkReadiness({ ...env, ANTNEST_AGENT_UI_BRIDGE_PORT: "0" }), false);
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});
