import { readFileSync } from "node:fs";
import { createServer as createHTTP } from "node:http";
import { createServer as createHTTPS } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNetworkDns } from "../lifecycle-closeout/network-dns.mjs";

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

export function createHttpsTarget({ key, cert, nonce }) {
  if (
    typeof nonce !== "string" ||
    nonce.length !== 32 ||
    !/^[0-9a-f]{32}$/u.test(nonce)
  )
    throw new TypeError("Invalid HTTPS fixture nonce");

  const requests = [],
    errors = [];
  const accepted = new Set();
  const sockets = new Map();
  const listening = new Set();
  let closing = false;
  let closePromise;

  const trackSocket = (socket, timeoutMs = 60000) => {
    // TLS/client errors can be reported from an already closed stream. Its
    // original close event will not repeat; never create a new wait for it.
    if (sockets.has(socket) || socket.closed) return;
    const closed = Promise.withResolvers();
    sockets.set(socket, closed.promise);
    socket.once("close", () => {
      sockets.delete(socket);
      closed.resolve();
    });
    // TLS rejection, reset and incomplete handshakes are intentional probes.
    // They must close their sockets without becoming business errors.
    socket.on("error", () => socket.destroy());
    socket.setTimeout(timeoutMs, () => socket.destroy());
    if (closing) socket.destroy();
  };

  const https = createHTTPS({ key, cert }, (request, response) => {
    try {
      const match = request.url?.match(
        /^\/probe\/([0-9a-f]{32})\/(created|updated)\/(ip|dns)$/u,
      );
      if (
        request.method !== "GET" ||
        match === undefined ||
        match === null ||
        match[1] !== nonce
      ) {
        errors.push("invalid HTTPS probe");
        json(response, 404, {});
        return;
      }
      const [, , phase, kind] = match;
      const tuple = phase + "/" + kind;
      if (accepted.has(tuple)) {
        errors.push("duplicate HTTPS probe");
        json(response, 409, {});
        return;
      }
      accepted.add(tuple);
      requests.push({
        nonce,
        phase,
        kind,
        peer: (request.socket.remoteAddress ?? "").replace(/^::ffff:/u, ""),
        host: request.headers.host ?? "",
      });
      json(response, 200, { nonce, phase, kind });
    } catch {
      errors.push("HTTPS probe handler failed");
      response.destroy();
    }
  });
  const http = createHTTP((request, response) => {
    try {
      if (request.method === "GET" && request.url === "/status") {
        json(response, 200, { requests, errors });
        return;
      }
      json(response, 404, {});
    } catch {
      errors.push("HTTP status handler failed");
      response.destroy();
    }
  });
  const dns = createNetworkDns();

  https.on("connection", trackSocket);
  https.on("secureConnection", trackSocket);
  https.on("tlsClientError", (_error, socket) => {
    socket.destroy();
  });
  http.on("connection", trackSocket);
  dns.server.on("connection", (socket) => trackSocket(socket, 5000));
  for (const server of [https, http])
    server.on("clientError", (_error, socket) => {
      socket.destroy();
    });

  for (const [server, name] of [
    [https, "HTTPS"],
    [http, "HTTP"],
    [dns.server, "DNS"],
  ]) {
    server.on("error", () => errors.push(name + " listener failed"));
    // Capture original listen operations too: close during startup cannot let
    // a pending listen open a new listener after cleanup has returned.
    const listen = server.listen;
    server.listen = function (...args) {
      if (closing) throw new Error("HTTPS fixture is closing");
      const settled = Promise.withResolvers();
      listening.add(settled.promise);
      const done = () => {
        server.removeListener("listening", done);
        server.removeListener("error", done);
        server.removeListener("close", done);
        listening.delete(settled.promise);
        settled.resolve();
      };
      server.once("listening", done);
      server.once("error", done);
      server.once("close", done);
      try {
        return listen.apply(server, args);
      } catch (error) {
        done();
        throw error;
      }
    };
  }

  const close = () => {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    closePromise = Promise.resolve().then(async () => {
      await Promise.all([...listening]);
      // Closing DNS's listener independently also covers a failing dns.close.
      // Every listener is attempted even when another cleanup rejects.
      const stops = [
        closeServer(https),
        closeServer(http),
        closeServer(dns.server),
        Promise.resolve().then(() => dns.close()),
      ];
      for (const socket of sockets.keys()) socket.destroy();
      const results = await Promise.allSettled(stops);
      while (sockets.size !== 0) await Promise.all([...sockets.values()]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length !== 0)
        throw new AggregateError(failures, "HTTPS fixture cleanup failed");
    });
    return closePromise;
  };

  return { https, http, dns: dns.server, close };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once("error", failed);
    try {
      server.listen(port, "0.0.0.0", () => {
        server.removeListener("error", failed);
        resolve();
      });
    } catch (error) {
      server.removeListener("error", failed);
      reject(error);
    }
  });
}

async function main() {
  const directory = process.env.ANTNEST_EGRESS_FIXTURE_TLS_DIRECTORY;
  if (typeof directory !== "string" || directory.length === 0)
    throw new TypeError("HTTPS fixture TLS directory is required");
  const target = createHttpsTarget({
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
    nonce: process.env.ANTNEST_EGRESS_FIXTURE_NONCE,
  });
  let stopping;
  const stop = () => {
    stopping ??= target.close().finally(() => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    });
    return stopping;
  };
  const interrupt = () => {
    void stop().catch(reportFailure);
  };
  const terminate = () => {
    void stop().catch(reportFailure);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await Promise.all([
      listen(target.https, 8443),
      listen(target.http, 8081),
      listen(target.dns, 15353),
    ]);
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "HTTPS fixture startup cleanup failed",
      );
    }
    throw error;
  }
}

function reportFailure(error) {
  process.exitCode = 1;
  process.stderr.write(
    JSON.stringify({
      event: "https_target_failed",
      error_type: error instanceof Error ? error.name : typeof error,
    }) + "\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch(reportFailure);
