// RC-owned protocol double; native Runtime admission is a later owning batch.
import assert from "node:assert/strict";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const spec = JSON.parse(process.env.ANTNEST_RUNTIME_SPEC);
const auth = spec.authentication;
assert(auth && /^rci_[0-9a-f]{32}$/.test(auth.connection_id));
assert.equal(auth.callers_file, "/run/antnest-auth/callers.json");
assert.equal(spec.network.packet_contract_revision, 2);
assert.equal(auth.tunnel.keys_file, "/run/antnest-auth/tunnel.json");
assert.equal(process.env.ANTNEST_SERVICE_AUTH_MODE, "token");
assert.equal(process.env.ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT, "true");
for (const [path, mode, file] of [
  ["/run/antnest-auth", 0o700, false],
  [auth.callers_file, 0o600, true],
  [auth.tunnel.keys_file, 0o600, true],
]) {
  const stat = lstatSync(path);
  assert.equal(stat.uid, 0);
  assert.equal(stat.mode & 0o7777, mode);
  assert.equal(file ? stat.isFile() : stat.isDirectory(), true);
}
const raw = readFileSync(auth.callers_file);
assert.equal(
  "sha256:" + createHash("sha256").update(raw).digest("hex"),
  auth.receiver_digest,
);
const callers = JSON.parse(raw);
const tunnel = readFileSync(auth.tunnel.keys_file);
assert.equal(
  "sha256:" + createHash("sha256").update(tunnel).digest("hex"),
  auth.tunnel.keys_digest,
);
assert.equal(JSON.parse(tunnel).key_id, auth.tunnel.key_id);
assert.deepEqual(Object.keys(callers).sort(), [
  "agent-acp-service",
  "runtime-controller",
]);
const execution = "execution-" + randomUUID();
const respond = (response, status, json) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(json));
};
const server = createServer((request, response) => {
  if (
    request.url === "/status/live" &&
    ["GET", "HEAD"].includes(request.method)
  )
    return respond(response, 200, { status: "ready" });
  const values = request.headersDistinct["antnest-service-authorization"] ?? [];
  const match =
    values.length === 1 && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(values[0]);
  const token = match && Buffer.from(match[1], "base64url");
  const hash =
    token && token.length === 32 && token.toString("base64url") === match[1]
      ? createHash("sha256").update(match[1]).digest()
      : null;
  const caller =
    hash &&
    Object.entries(callers).find(([, hashes]) =>
      hashes.some((digest) =>
        timingSafeEqual(hash, Buffer.from(digest.slice(7), "hex")),
      ),
    )?.[0];
  if (!caller) return respond(response, 401, { code: "runtime_unauthorized" });
  if (request.url === "/status")
    return respond(response, 200, {
      agent_id: spec.agent_id,
      generation: spec.generation,
      execution_id: execution,
      status: "ready",
      test_features: [],
    });
  return respond(response, caller === "agent-acp-service" ? 501 : 403, {
    code:
      caller === "agent-acp-service"
        ? "fixture_mcp_not_implemented"
        : "caller_not_allowed",
  });
});
server.listen(spec.listen.port, spec.listen.host);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close());
