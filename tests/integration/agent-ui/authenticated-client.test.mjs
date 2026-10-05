import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ServiceAuthentication } from "../../../services/agent-ui/web/server/dist/adapters/service-authentication.js";
import { testSecurityEnvironment } from "./auth-fixture.mjs";

test("authenticated client rereads atomic token replacement and refuses stale fallback, redirects and foreign origins", async () => {
  const received = [];
  const server = createServer((request, response) => {
    received.push(request.headers["antnest-service-authorization"]);
    if (request.url === "/redirect")
      response.writeHead(302, { location: "http://untrusted.invalid/" });
    response.end("ok");
  });
  const environment = testSecurityEnvironment();
  const authentication = new ServiceAuthentication(environment);
  const path = join(
    environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR,
    "agent-acp-service",
  );
  const original = readFileSync(path, "utf8");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const fetcher = authentication.fetchFor("agent-acp-service", origin);
    assert.equal(await (await fetcher(origin)).text(), "ok");
    const next = randomBytes(32).toString("base64url");
    writeFileSync(path + ".next", next, { mode: 0o600 });
    renameSync(path + ".next", path);
    assert.equal(
      await (
        await fetcher(origin, {
          headers: { "Antnest-Service-Authorization": "forged" },
        })
      ).text(),
      "ok",
    );
    assert.deepEqual(received, [`Bearer ${original}`, `Bearer ${next}`]);
    writeFileSync(path, next + "\n");
    await assert.rejects(fetcher(origin), /service_credential_invalid/u);
    unlinkSync(path);
    await assert.rejects(fetcher(origin), /credential_file_invalid/u);
    assert.equal(received.length, 2);
    writeFileSync(path, next, { mode: 0o600 });
    await assert.rejects(
      fetcher("http://untrusted.invalid/"),
      /dependency_origin_invalid/u,
    );
    await assert.rejects(
      fetcher(origin, { headers: { host: "untrusted.invalid" } }),
      /dependency_origin_invalid/u,
    );
    await assert.rejects(fetcher(origin + "/redirect"));
    assert.equal(received.length, 3);
  } finally {
    writeFileSync(path, original, { mode: 0o600 });
    await authentication.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
