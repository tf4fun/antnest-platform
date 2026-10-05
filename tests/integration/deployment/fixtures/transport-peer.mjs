import { createServer } from "node:http";

const prefix = process.env.ANTNEST_SERVICE_NETWORK_PREFIX;
const servers = [];
function listen(host, port, receive) {
  const server = createServer(receive);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}
if (process.env.TRANSPORT_PEER_KIND === "receiver") {
  await listen(`${prefix}.50`, 8080, (incoming, response) => {
    const authorized =
      incoming.headers["antnest-service-authorization"] ===
      "Bearer fixture-exact";
    response.writeHead(authorized ? 200 : 401, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(
      JSON.stringify({
        service_authorization:
          incoming.headers["antnest-service-authorization"] ?? null,
        caller_context: incoming.headers["antnest-caller-context"] ?? null,
      }),
    );
  });
} else if (process.env.TRANSPORT_PEER_KIND === "collector") {
  await listen(`${prefix}.114`, 4318, (incoming, response) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("error", () => {});
    incoming.once("end", () => {
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "fixture-authority",
        connection: "close",
      });
      response.end(
        JSON.stringify({
          path: incoming.url,
          body: Buffer.concat(chunks).toString("base64"),
          headers: incoming.headers,
        }),
      );
    });
  });
  await listen(`${prefix}.114`, 16686, (_incoming, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(JSON.stringify({ surface: "query-ui" }));
  });
} else {
  await listen(process.env.PROBE_ADDRESS, 8080, (_incoming, response) =>
    response.end("ready"),
  );
}
async function stop() {
  for (const server of servers) {
    const stopped = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await stopped;
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void stop();
  });
