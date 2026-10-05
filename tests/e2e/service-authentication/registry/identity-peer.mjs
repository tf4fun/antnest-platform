import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

if (process.argv.includes("--healthcheck")) {
  const response = await fetch("http://127.0.0.1:8080/status", {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  await response.body?.cancel();
} else {
  const fixture = JSON.parse(readFileSync("/run/auth/peers.json", "utf8"));
  const server = createServer((request, response) => {
    if (request.url === "/status") {
      response.end("ok");
      return;
    }
    const auth = request.headers["antnest-service-authorization"] ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const hash =
      "sha256:" + createHash("sha256").update(token, "ascii").digest("hex");
    const fields = request.rawHeaders.filter(
      (value, index) =>
        index % 2 === 0 &&
        value.toLowerCase() === "antnest-service-authorization",
    );
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["antnest-caller-context"], undefined);
    if (fields.length !== 1 || hash !== fixture.hashes["identity-service"]) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.url !== "/rpc/identity/jwks" || request.method !== "GET") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(fixture.jwks));
  });
  server.listen(8080, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
}
