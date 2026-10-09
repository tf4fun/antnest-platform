import { createServer as createTCP } from "node:net";
import { createServer as createHTTP } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createNetworkDns } from "./network-dns.mjs";

export function createNetworkTarget() {
  const dns = createNetworkDns();
  const requests = [],
    errors = [],
    pushed = [];
  const held = new Map(),
    sockets = new Set();
  const tcp = createTCP((socket) => {
    sockets.add(socket);
    socket.setTimeout(60000, () => socket.destroy());
    const socketError = (error) => {
      if (!["ECONNRESET", "EPIPE"].includes(error.code))
        errors.push("unexpected socket error");
    };
    socket.on("error", socketError);
    socket.on("close", () => {
      sockets.delete(socket);
      for (const [key, value] of held) if (value === socket) held.delete(key);
    });
    let bytes = 0;
    socket.on("data", (data) => {
      bytes += data.length;
      if (bytes > 8192) socket.destroy();
    });
    const reader = createInterface({ input: socket, crlfDelay: Infinity });
    reader.on("error", socketError);
    reader.on("line", (line) => {
      try {
        const { phase, nonce } = JSON.parse(line);
        assert.match(phase, /^(allowed|restored|held-[ab](-next)?)$/);
        assert.match(nonce, /^[a-z0-9-]{6,64}$/);
        assert(!requests.some((r) => r.phase === phase && r.nonce === nonce));
        requests.push({
          phase,
          nonce,
          peer: socket.remoteAddress.replace(/^::ffff:/, ""),
        });
        if (phase === "held-a" || phase === "held-b") held.set(nonce, socket);
        socket.write(JSON.stringify({ phase, nonce }) + "\n");
      } catch {
        errors.push("unexpected TCP probe");
        socket.destroy();
      }
    });
  });
  const http = createHTTP(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/status") {
      response.end(JSON.stringify({ requests, errors, pushed }));
      return;
    }
    const nonce = request.url?.match(/^\/push\/([a-z0-9-]{6,64})$/)?.[1];
    const socket = held.get(nonce);
    if (request.method !== "POST" || !socket || pushed.includes(nonce)) {
      response.writeHead(409).end("{}");
      return;
    }
    try {
      await new Promise((resolve, reject) =>
        socket.write(JSON.stringify({ push: nonce }) + "\n", (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      pushed.push(nonce);
      response.end(JSON.stringify({ pushed: nonce }));
    } catch {
      response.writeHead(503).end("{}");
    }
  });
  return {
    tcp,
    http,
    dns: dns.server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await dns.close();
      await new Promise((resolve) => tcp.close(resolve));
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = createNetworkTarget();
  target.tcp.listen(18080, "0.0.0.0");
  target.http.listen(8081, "0.0.0.0");
  target.dns.listen(15353, "0.0.0.0");
}
