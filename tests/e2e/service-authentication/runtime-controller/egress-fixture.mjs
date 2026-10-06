// RC-owned registration double. Real encrypted Egress admission is an owning batch.
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const token = readFileSync("/run/auth/runtime-egress");
const accepted = new Map();
const server = createServer(async (request, response) => {
  const credential = request.headers["antnest-service-authorization"];
  const presented = Buffer.from(
    credential?.startsWith("Bearer ") ? credential.slice(7) : "",
  );
  if (presented.length !== token.length || !timingSafeEqual(presented, token)) {
    response.writeHead(401).end();
    return;
  }
  if (
    request.method !== "PUT" ||
    !/^\/internal\/agent-tunnel-keys\/[A-Za-z0-9_-]+$/u.test(request.url)
  ) {
    response.writeHead(404).end();
    return;
  }
  if (existsSync("/run/auth/registration-unavailable")) {
    response.writeHead(503).end();
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString();
  const value = JSON.parse(body);
  if (
    Object.keys(value).sort().join(",") !==
      "egress_private_key,key_id,preshared_key,runtime_public_key,runtime_revision,tunnel_ipv4" ||
    !/^rtk_[0-9a-f]{32}$/u.test(value.key_id)
  ) {
    response.writeHead(400).end();
    return;
  }
  if (accepted.has(value.key_id) && accepted.get(value.key_id) !== body) {
    response.writeHead(409).end();
    return;
  }
  accepted.set(value.key_id, body);
  response.writeHead(204).end();
});
server.listen(8081, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close());
