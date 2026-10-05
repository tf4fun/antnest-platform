import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, isIPv4, Socket } from "node:net";
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
const limits = contract.infrastructure.diagnostics;

function invalid() {
  throw new Error("invalid diagnostic configuration");
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
}

export function diagnosticConfiguration(
  prefix = contract.default_service_prefix,
) {
  if (typeof prefix !== "string" || !isIPv4(`${prefix}.0`)) invalid();
  const [first, second] = prefix.split(".").map(Number);
  if (!(
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  ))
    invalid();
  return {
    host: `${prefix}.${limits.bind_address_suffix}`,
    targets: Object.entries(limits.listener_ports).map(
      ([name, listenPort]) => ({
        name,
        listenPort,
        targetHost: `${prefix}.${limits.targets[name].address_suffix}`,
        targetPort: limits.targets[name].port,
      }),
    ),
  };
}

export async function startDiagnosticRelay({
  host,
  targets,
  maxConnections = limits.max_connections,
  connectTimeoutMs = limits.connect_timeout_ms,
  idleTimeoutMs = limits.idle_timeout_ms,
  signal,
}) {
  if (!isIPv4(host) || host === "0.0.0.0" || !Array.isArray(targets)) invalid();
  integer(targets.length, 1, Object.keys(limits.listener_ports).length);
  integer(maxConnections, 1, limits.max_connections);
  integer(connectTimeoutMs, 1, limits.connect_timeout_ms);
  integer(idleTimeoutMs, 1, limits.idle_timeout_ms);
  const names = new Set(),
    ports = new Set();
  const routes = targets.map((target) => {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/u.test(target.name) ||
      names.has(target.name) ||
      !isIPv4(target.targetHost) ||
      target.targetHost === "0.0.0.0"
    )
      invalid();
    integer(target.listenPort, 0, 65535);
    integer(target.targetPort, 1, 65535);
    if (target.listenPort && ports.has(target.listenPort)) invalid();
    names.add(target.name);
    ports.add(target.listenPort);
    return { ...target };
  });
  signal?.throwIfAborted();

  const servers = [],
    pairs = new Set(),
    addresses = {};
  const closed = Promise.withResolvers();
  let closing, failure;
  const stopOnAbort = () => {
    void close();
  };
  function close() {
    if (closing) return closing;
    closing = (async () => {
      signal?.removeEventListener("abort", stopOnAbort);
      const stops = servers.map((server) =>
        server.listening
          ? new Promise((resolve) => server.close(resolve))
          : Promise.resolve(),
      );
      for (const pair of pairs) pair.destroy();
      await Promise.all(stops);
      closed.resolve();
    })();
    return closing;
  }
  signal?.addEventListener("abort", stopOnAbort, { once: true });

  try {
    for (const route of routes) {
      signal?.throwIfAborted();
      const server = createServer(
        {
          allowHalfOpen: true,
          pauseOnConnect: true,
          noDelay: true,
          highWaterMark: limits.max_buffer_bytes_per_stream,
        },
        (incoming) => {
          incoming.on("error", () => {});
          if (closing || pairs.size >= maxConnections) {
            incoming.destroy();
            return;
          }
          const upstream = new Socket({
            allowHalfOpen: true,
            highWaterMark: limits.max_buffer_bytes_per_stream,
          });
          let remaining = 2;
          const timer = setTimeout(() => pair.destroy(), connectTimeoutMs);
          timer.unref();
          const pair = {
            destroy() {
              clearTimeout(timer);
              incoming.destroy();
              upstream.destroy();
            },
          };
          pairs.add(pair);
          for (const socket of [incoming, upstream]) {
            socket.on("error", () => pair.destroy());
            socket.once("close", () => {
              pair.destroy();
              if (--remaining === 0) pairs.delete(pair);
            });
            socket.setTimeout(idleTimeoutMs, () => pair.destroy());
          }
          upstream.setNoDelay(true);
          upstream.once("connect", () => clearTimeout(timer));
          incoming.pipe(upstream);
          upstream.pipe(incoming);
          upstream.connect({ host: route.targetHost, port: route.targetPort });
        },
      );
      servers.push(server);
      server.on("error", (error) => {
        failure = error;
        void close();
      });
      const listening = once(server, "listening", { signal });
      server.listen({ host, port: route.listenPort, signal });
      await listening;
      addresses[route.name] = server.address();
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    addresses,
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
    const relay = await startDiagnosticRelay({
      ...diagnosticConfiguration(process.env.ANTNEST_SERVICE_NETWORK_PREFIX),
      signal: controller.signal,
    });
    console.log(
      JSON.stringify({
        service: "diagnostic-relay",
        status: "ready",
        listeners: Object.keys(relay.addresses).length,
      }),
    );
    await relay.closed;
    if (relay.failure) throw relay.failure;
  } catch {
    console.error("diagnostic-relay initialization failed");
    process.exitCode = 1;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  }
}
