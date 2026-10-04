// A synthetic Provider on an internal, public-classified Docker subnet.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const stats = { calls: 0, failures: 0, redirects: 0 };
const server = createServer(async (request, response) => {
  if (request.url === "/test/state") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(stats));
    return;
  }
  stats.calls++;
  if (
    request.headers.authorization !== "Bearer synthetic-provider-secret" ||
    Object.keys(request.headers).some(
      (name) => name.startsWith("antnest-") || name.startsWith("x-antnest-"),
    ) ||
    request.headers.cookie ||
    request.headers.baggage
  ) {
    stats.failures++;
    response.writeHead(401);
    response.end("fixture boundary failed");
    return;
  }
  const parts = [];
  for await (const part of request) parts.push(part);
  if (request.url === "/relay/v1/chat/completions") {
    // Fixed test-only backend: the production adapter connects to this
    // controlled Provider, not Docker Desktop's reserved host gateway.
    try {
      const upstream = await fetch(
        process.env.FIXTURE_ORIGIN + "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            authorization: request.headers.authorization,
            "content-type": "application/json",
          },
          body: Buffer.concat(parts),
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        },
      );
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (upstream.body)
        await pipeline(Readable.fromWeb(upstream.body), response);
      else response.end();
    } catch {
      stats.failures++;
      response.destroy();
    }
    return;
  }
  if (request.url === "/redirect/chat/completions") {
    stats.redirects++;
    response.writeHead(302, {
      location: "http://127.0.0.1:8080/private-identity",
    });
    response.end("synthetic-provider-secret");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "public-fixture-ok" },
        },
      ],
    }),
  );
});
server.listen(8110, "0.0.0.0");
function stop() {
  server.close();
  server.closeAllConnections();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
