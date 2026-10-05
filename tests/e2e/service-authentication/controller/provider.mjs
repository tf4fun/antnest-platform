// Isolated Provider fixture on an internal, public-classified Docker subnet.
// No Internet request, real credential or model inference occurs.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const { providerSecret } = JSON.parse(
  readFileSync("/run/auth/fixture.json", "utf8"),
);
const state = { calls: 0, failures: 0, redirects: 0 };
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  response.setHeader("Content-Type", "application/json");
  if (path === "/status" || path === "/test/state") {
    response.end(JSON.stringify(state));
    return;
  }
  state.calls++;
  if (
    request.headers.authorization !== "Bearer " + providerSecret ||
    request.headers["antnest-service-authorization"] ||
    request.headers["antnest-caller-context"] ||
    request.headers.cookie ||
    Object.keys(request.headers).some((name) => name.startsWith("x-antnest-"))
  ) {
    state.failures++;
    response.writeHead(401);
    response.end(JSON.stringify({ error: providerSecret }));
    return;
  }
  if (path === "/redirect/models") {
    response.writeHead(302, {
      Location: "http://dependencies:8101/rpc/identity/jwks",
    });
    response.end(JSON.stringify({ error: providerSecret }));
    return;
  }
  if (path !== "/v1/models") {
    state.redirects++;
    response.writeHead(404);
    response.end("{}");
    return;
  }
  response.end(
    JSON.stringify({
      data: [
        {
          id: "fixture-model",
          name: "Fixture",
          context_length: 128000,
          top_provider: { max_completion_tokens: 8192 },
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    }),
  );
});
server.listen(8110, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
