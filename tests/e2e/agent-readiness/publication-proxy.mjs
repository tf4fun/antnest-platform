import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const applyPath = "/rpc/agent-acp/apply-execution-snapshot";
const now = () => performance.now();
function endToEnd(headers) {
  const excluded = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !excluded.has(name)),
  );
}
function parse(bytes) {
  try {
    return JSON.parse(bytes.toString());
  } catch {
    return null;
  }
}
function completed(stream) {
  return new Promise((resolve) => {
    stream.on("error", () => {});
    stream.once("close", resolve);
  });
}

// A transparent test seam. No credentials, retry, ACK or readiness is synthesized.
export function createPublicationProxy({ upstream, delayMs = 2000 }) {
  const target = new URL(upstream);
  assert.equal(target.protocol, "http:");
  assert.equal(target.pathname, "/");
  assert(
    !target.username && !target.password && !target.search && !target.hash,
  );
  assert(Number.isSafeInteger(delayMs) && delayMs >= 0);
  const attempts = [],
    tasks = new Set(),
    owners = new Set(),
    sockets = new Set();
  let closing;
  const server = createServer((request, response) => {
    if (!request.url.startsWith("/") || request.url.startsWith("//")) {
      request.resume();
      response.writeHead(400, { connection: "close" }).end();
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.writeHead(closing ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ delayMs, active: tasks.size, attempts }));
      return;
    }
    const owner = new AbortController();
    owners.add(owner);
    const attempt = {
      id: randomUUID(),
      path: request.url,
      receivedAt: now(),
      delayStartedAt: null,
      forwardedAt: null,
      upstreamCompletedAt: null,
      completedAt: null,
      cancelled: false,
      requestSha256: null,
      organizationId: null,
      revision: null,
      bindings: [],
      appliedRevision: null,
      status: null,
    };
    attempts.push(attempt);
    const cancel = () =>
      owner.abort(new Error("publication downstream closed"));
    request.once("aborted", cancel);
    response.once("close", () => {
      if (!response.writableFinished) cancel();
    });
    const task = forward(request, response, owner, attempt).finally(() => {
      attempt.completedAt = now();
      owners.delete(owner);
      tasks.delete(task);
    });
    tasks.add(task);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  async function forward(request, response, owner, attempt) {
    const joined = [],
      signal = owner.signal;
    let sent, upstreamResponse;
    const stop = () => {
      sent?.destroy();
      upstreamResponse?.destroy();
      request.destroy();
      response.destroy();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      signal.throwIfAborted();
      const body = Buffer.concat(chunks),
        input = parse(body);
      attempt.requestSha256 = createHash("sha256").update(body).digest("hex");
      attempt.organizationId =
        typeof input?.organization_id === "string"
          ? input.organization_id
          : null;
      attempt.revision = Number.isSafeInteger(input?.revision)
        ? input.revision
        : null;
      attempt.bindings = Array.isArray(input?.agents)
        ? input.agents.map((agent) => ({
            agent_id: agent?.agent_id,
            agent_spec_revision: agent?.agent_spec_revision,
            execution_revision: agent?.execution_revision,
            runtime_revision: agent?.runtime?.runtime_revision ?? null,
            accepting_runs: agent?.accepting_runs,
          }))
        : [];
      if (request.method === "POST" && request.url === applyPath) {
        attempt.delayStartedAt = now();
        while (now() - attempt.delayStartedAt < delayMs)
          await delay(
            Math.ceil(delayMs - (now() - attempt.delayStartedAt)),
            undefined,
            { signal },
          );
      }
      signal.throwIfAborted();
      const headers = endToEnd(request.headers);
      headers.host = target.host;
      headers["content-length"] = String(body.length);
      headers.connection = "close";
      attempt.forwardedAt = now();
      await new Promise((resolve, reject) => {
        sent = httpRequest({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: request.url,
          method: request.method,
          headers,
        });
        joined.push(completed(sent));
        sent.once("error", reject);
        sent.once("response", (incoming) => {
          upstreamResponse = incoming;
          joined.push(completed(incoming));
          attempt.status = incoming.statusCode;
          response.writeHead(
            incoming.statusCode,
            incoming.statusMessage,
            endToEnd(incoming.headers),
          );
          const received = [];
          incoming.on("data", (chunk) => received.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () => {
            attempt.upstreamCompletedAt = now();
            const output = parse(Buffer.concat(received));
            if (
              output?.organization_id === attempt.organizationId &&
              Number.isSafeInteger(output?.applied_revision)
            )
              attempt.appliedRevision = output.applied_revision;
          });
          incoming.once("close", () => {
            if (!incoming.complete)
              reject(new Error("publication upstream body incomplete"));
          });
          response.once("finish", resolve);
          response.once("close", () => {
            if (!response.writableFinished)
              reject(new Error("publication downstream body incomplete"));
          });
          incoming.pipe(response);
        });
        sent.end(body);
      });
    } catch (error) {
      attempt.cancelled = signal.aborted;
      // Private status excludes raw headers and payloads, which contain credentials.
      if (!signal.aborted) attempt.error = "publication forwarding failed";
      stop();
    } finally {
      await Promise.all(joined);
      signal.removeEventListener("abort", stop);
    }
  }
  return {
    server,
    attempts,
    close() {
      return (closing ??= (async () => {
        const stopped = new Promise((resolve, reject) =>
          server.close((error) =>
            error && error.code !== "ERR_SERVER_NOT_RUNNING"
              ? reject(error)
              : resolve(),
          ),
        );
        for (const owner of owners)
          owner.abort(new Error("publication proxy closing"));
        for (const socket of sockets) socket.destroy();
        await Promise.all([...tasks]);
        await stopped;
      })());
    },
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const proxy = createPublicationProxy({
    upstream:
      process.env.ANTNEST_READINESS_UPSTREAM ?? "http://agent-acp-control:8081",
  });
  proxy.server.listen(8080, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void proxy.close().catch(() => {
        process.exitCode = 1;
      });
    });
}
