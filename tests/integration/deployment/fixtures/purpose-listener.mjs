import { createServer } from "node:http";

const servers = [];
for (const [name, address] of [
  ["purpose", process.env.PURPOSE_ADDRESS],
  ["outbound", process.env.OUTBOUND_ADDRESS],
]) {
  if (!address) continue;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ listener: name }));
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8080, address, resolve);
  });
}
async function stop() {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void stop();
  });
