import assert from "node:assert/strict";
import { createServer, request } from "node:http";

const upstream = process.env.ANTNEST_TEST_REGISTRY_UPSTREAM;
const port = Number(process.env.ANTNEST_TEST_SLOW_PROXY_PORT);
assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(upstream ?? ""));
assert(Number.isInteger(port) && port > 0 && port < 65536);
let armed = false;
let delayed = 0;
const requests = {};

const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/__test/status" && incoming.method === "GET") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ armed, delayed, requests }));
    return;
  }
  if (incoming.url === "/__test/arm" && incoming.method === "POST") {
    armed = true;
    outgoing.writeHead(204);
    outgoing.end();
    return;
  }
  const target = new URL(incoming.url ?? "/", upstream);
  const artifact =
    /^\/internal\/skills\/(skill_[0-9a-f]{32})\/versions\/[1-9][0-9]*\/artifact$/.exec(
      target.pathname,
    );
  if (armed && incoming.method === "GET" && artifact) {
    requests[artifact[1]] = (requests[artifact[1]] ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, 25000));
    delayed++;
  }
  const forwarded = request(
    target,
    { method: incoming.method, headers: incoming.headers },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  forwarded.on("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(error.message);
  });
  incoming.pipe(forwarded);
});
server.listen(port, "127.0.0.1");
