import { createServer, request } from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function startObservationProxy({
  socketPath = "/fault/docker.sock",
  upstreamSocket = "/var/run/docker.sock",
  host = "0.0.0.0",
  port = 8081,
} = {}) {
  const connections = new Set();
  let forwarded = 0;
  const docker = createServer((incoming, outgoing) => {
    forwarded++;
    const upstream = request(
      {
        socketPath: upstreamSocket,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        outgoing.flushHeaders();
        response.on("error", () => outgoing.destroy());
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  docker.on("connection", (connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  });
  if (existsSync(socketPath)) unlinkSync(socketPath);

  async function online() {
    if (docker.listening) return;
    await new Promise((resolve, reject) => {
      docker.once("error", reject);
      docker.listen(socketPath, () => {
        docker.off("error", reject);
        resolve();
      });
    });
  }
  async function offline() {
    for (const connection of connections) connection.destroy();
    if (docker.listening)
      await new Promise((resolve, reject) =>
        docker.close((error) => (error ? reject(error) : resolve())),
      );
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
  const control = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method === "POST" && incoming.url === "/online")
        await online();
      else if (incoming.method === "POST" && incoming.url === "/offline")
        await offline();
      else if (incoming.method !== "GET" || incoming.url !== "/status") {
        outgoing.writeHead(404);
        outgoing.end();
        return;
      }
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ online: docker.listening, forwarded }));
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(port, host, () => {
      control.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${control.address().port}`,
    async close() {
      await offline();
      control.closeAllConnections();
      await new Promise((resolve, reject) =>
        control.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const proxy = await startObservationProxy();
  const stop = () => {
    proxy.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
