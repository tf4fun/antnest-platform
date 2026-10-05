import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { isIPv4 } from "node:net";
import { pathToFileURL } from "node:url";

const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/platform/development-network-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const limits = contract.infrastructure.runtime_telemetry_ingress;
const paths = new Set(limits.paths);

function invalid() {
  throw new Error("invalid telemetry configuration");
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
}
function privateAddress(address) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
export function runtimeTelemetryConfiguration(
  prefix = contract.default_service_prefix,
  host = "172.30.255.4",
) {
  if (
    typeof prefix !== "string" ||
    !privateAddress(`${prefix}.0`) ||
    !privateAddress(host)
  )
    invalid();
  return {
    host,
    port: limits.port,
    upstreamHost: `${prefix}.${contract.networks.observability.members.jaeger}`,
    upstreamPort: limits.upstream_port,
  };
}

function transportError(status) {
  return Object.assign(new Error("telemetry transport failed"), {
    transportStatus: status,
  });
}
function readBounded(message, limit, tooLargeStatus, signal) {
  return new Promise((resolve, reject) => {
    let chunks = [],
      bytes = 0,
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      message.off("data", data);
      message.off("end", end);
      message.off("error", failed);
      message.off("aborted", failed);
      signal.removeEventListener("abort", aborted);
      chunks = [];
      if (error) {
        message.pause();
        reject(error);
      } else resolve(value);
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) finish(transportError(tooLargeStatus));
      else chunks.push(chunk);
    };
    const end = () => finish(undefined, Buffer.concat(chunks, bytes));
    const failed = () => finish(transportError(502));
    const aborted = () => finish(signal.reason);
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    message.on("data", data);
    message.once("end", end);
    message.once("error", failed);
    message.once("aborted", failed);
  });
}

export async function startRuntimeTelemetryIngress({
  host,
  port = limits.port,
  upstreamHost,
  upstreamPort = limits.upstream_port,
  maxBodyBytes = limits.max_wire_body_bytes,
  maxResponseBytes = limits.max_upstream_response_bytes,
  maxInflight = limits.max_inflight,
  timeoutMs = limits.timeout_ms,
  signal,
}) {
  if (
    !isIPv4(host) ||
    host === "0.0.0.0" ||
    !isIPv4(upstreamHost) ||
    upstreamHost === "0.0.0.0"
  )
    invalid();
  integer(port, 0, 65535);
  integer(upstreamPort, 1, 65535);
  integer(maxBodyBytes, 1, limits.max_wire_body_bytes);
  integer(maxResponseBytes, 1, limits.max_upstream_response_bytes);
  integer(maxInflight, 1, limits.max_inflight);
  integer(timeoutMs, 1, limits.timeout_ms);
  signal?.throwIfAborted();

  const jobs = new Set(),
    sockets = new Set(),
    closed = Promise.withResolvers();
  let closing, failure;
  const reply = (response, status, body = Buffer.alloc(0), headers = {}) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      ...headers,
      "content-length": String(body.length),
      connection: "close",
    });
    response.end(body);
  };
  const server = createServer(
    {
      maxHeaderSize: 8192,
      highWaterMark: 65536,
      headersTimeout: Math.min(timeoutMs, 5000),
      requestTimeout: timeoutMs,
      connectionsCheckingInterval: Math.min(timeoutMs, 1000),
    },
    (incoming, response) => {
      incoming.on("error", () => {});
      if (!paths.has(incoming.url)) {
        reply(response, 404);
        return;
      }
      if (incoming.method !== "POST") {
        reply(response, 405);
        return;
      }
      if (Number(incoming.headers["content-length"]) > maxBodyBytes) {
        reply(response, 413);
        return;
      }
      if (closing || jobs.size >= maxInflight) {
        reply(response, 503);
        return;
      }
      const controller = new AbortController();
      const job = { controller, upstream: undefined, done: undefined };
      const cancel = () => {
        controller.abort(transportError(502));
        job.upstream?.destroy();
      };
      response.once("close", cancel);
      const deadline = setTimeout(() => {
        controller.abort(transportError(504));
        job.upstream?.destroy();
      }, timeoutMs);
      deadline.unref();
      jobs.add(job);
      job.done = (async () => {
        const body = await readBounded(
          incoming,
          maxBodyBytes,
          413,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        const headers = {};
        for (const name of limits.forwarded_request_headers)
          if (incoming.headers[name] !== undefined)
            headers[name] = incoming.headers[name];
        const result = await new Promise((resolve, reject) => {
          const outgoing = request(
            {
              hostname: upstreamHost,
              port: upstreamPort,
              method: "POST",
              path: incoming.url,
              headers,
              agent: false,
            },
            (upstream) => {
              upstream.on("error", () => {});
              const declared = Number(upstream.headers["content-length"]);
              if (declared > maxResponseBytes) {
                outgoing.destroy();
                reject(transportError(502));
                return;
              }
              void readBounded(
                upstream,
                maxResponseBytes,
                502,
                controller.signal,
              ).then(
                (bytes) => {
                  const acceptedHeaders = {};
                  for (const name of limits.forwarded_request_headers)
                    if (upstream.headers[name] !== undefined)
                      acceptedHeaders[name] = upstream.headers[name];
                  resolve({
                    status: upstream.statusCode,
                    body: bytes,
                    headers: acceptedHeaders,
                  });
                },
                (error) => {
                  outgoing.destroy();
                  reject(error);
                },
              );
            },
          );
          job.upstream = outgoing;
          outgoing.once("error", () =>
            reject(
              controller.signal.aborted
                ? controller.signal.reason
                : transportError(502),
            ),
          );
          outgoing.end(body);
        });
        reply(response, result.status, result.body, result.headers);
      })()
        .catch((error) => {
          job.upstream?.destroy();
          reply(
            response,
            [413, 504].includes(error?.transportStatus)
              ? error.transportStatus
              : 502,
          );
        })
        .finally(() => {
          clearTimeout(deadline);
          response.off("close", cancel);
          jobs.delete(job);
        });
    },
  );
  server.maxConnections = maxInflight * 2;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  for (const event of ["connect", "upgrade"])
    server.on(event, (_incoming, socket) =>
      socket.end(
        "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      ),
    );
  const stopOnAbort = () => {
    void close();
  };
  function close() {
    if (closing) return closing;
    closing = (async () => {
      signal?.removeEventListener("abort", stopOnAbort);
      const stopped = server.listening
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve();
      const pending = [...jobs].map((job) => {
        job.controller.abort(transportError(502));
        job.upstream?.destroy();
        return job.done;
      });
      for (const socket of sockets) socket.destroy();
      await Promise.all([stopped, ...pending]);
      closed.resolve();
    })();
    return closing;
  }
  server.on("error", (error) => {
    failure = error;
    void close();
  });
  signal?.addEventListener("abort", stopOnAbort, { once: true });
  try {
    const listening = once(server, "listening", { signal });
    server.listen({ host, port, signal });
    await listening;
  } catch (error) {
    await close();
    throw error;
  }
  return {
    address: server.address(),
    close,
    closed: closed.promise,
    get failure() {
      return failure;
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  try {
    const ingress = await startRuntimeTelemetryIngress({
      ...runtimeTelemetryConfiguration(
        process.env.ANTNEST_SERVICE_NETWORK_PREFIX,
        process.env.ANTNEST_RUNTIME_OTLP_INGRESS_IPV4,
      ),
      signal: controller.signal,
    });
    console.log(
      JSON.stringify({ service: "runtime-telemetry-ingress", status: "ready" }),
    );
    await ingress.closed;
    if (ingress.failure) throw ingress.failure;
  } catch {
    console.error("runtime-telemetry-ingress initialization failed");
    process.exitCode = 1;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  }
}
