import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

// Loaded only by the disposable ACP container of the install interruption
// E2E. ANTNEST_E2E_INSTALL_GATE selects one interruption of the first Skill
// install; every later install is the resend and reaches the Runtime as is.
//   response: the Runtime installs, ACP's receipt is held (lost on /drop)
//   dispatch: the request is held before the Runtime sees it
//   observe:  installs pass through; only in-flight aborts are recorded
// NODE_OPTIONS loads this file into every node process in the container,
// including the `node -e` healthcheck, which must not take the gate's port.
const modes = ["response", "dispatch", "observe"];
if (process.argv[1]?.endsWith("/dist/main.js")) await install();

// ACP reaches Runtime only through RuntimeConnections.fetchFor, which calls
// undici with its own dispatcher and never the global fetch. Gating anything
// else would leave every scenario waiting for a request it can never see, so
// a missing hook stops ACP instead of starting ungated.
// The module graph is free of pg, so loading it here does not preempt the
// instrumentation that main registers before composition.
async function install() {
  const mode = process.env.ANTNEST_E2E_INSTALL_GATE;
  if (!modes.includes(mode))
    throw new Error(
      `ANTNEST_E2E_INSTALL_GATE must be one of ${modes.join(", ")}`,
    );
  const transport = new URL(
    "./adapters/runtime-connections.js",
    pathToFileURL(process.argv[1]),
  );
  let RuntimeConnections;
  try {
    ({ RuntimeConnections } = await import(transport.href));
  } catch (error) {
    throw new Error(`Maintenance gate cannot load ${transport.pathname}`, {
      cause: error,
    });
  }
  const fetchFor = RuntimeConnections?.prototype?.fetchFor;
  if (typeof fetchFor !== "function")
    throw new Error(
      `Maintenance gate found no RuntimeConnections.fetchFor in ${transport.pathname}`,
    );
  let installs = 0;
  let pending = null;
  let aborted = false;
  RuntimeConnections.prototype.fetchFor = function (binding) {
    return gated(fetchFor.call(this, binding));
  };
  // A held promise must reject on abort exactly as undici does; otherwise the
  // gate, not ACP, would decide whether lifecycle or foreground work waits.
  const hold = (signal, entry) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        aborted = true;
        if (pending?.signal === signal) pending = null;
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const settle = (action) => (value) => {
        signal?.removeEventListener("abort", onAbort);
        action(value);
      };
      pending = { signal, ...entry(settle(resolve), settle(reject)) };
    });
  const gated = (originalFetch) => async (input, init) => {
    const address =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url;
    if (new URL(address).pathname !== "/internal/skill-maintenance/install")
      return originalFetch(input, init);
    installs += 1;
    const signal = init?.signal;
    if (mode === "observe" || installs > 1) {
      if (mode !== "observe") return originalFetch(input, init);
      const onAbort = () => {
        aborted = true;
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await originalFetch(input, init);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    if (mode === "dispatch")
      return hold(signal, (resolve, reject) => ({
        release: () => originalFetch(input, init).then(resolve, reject),
      }));
    const response = await originalFetch(input, init);
    const body = await response.arrayBuffer();
    const complete = new Response(body, {
      status: response.status,
      headers: response.headers,
    });
    return hold(signal, (resolve, reject) => ({
      release: () => resolve(complete),
      drop: () => reject(new Error("Held Runtime install response lost")),
    }));
  };

  createServer((request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, {
        mode,
        installs,
        pending: pending !== null,
        aborted,
      });
    if (request.method === "POST" && request.url === "/release") {
      if (!pending) return reply(409, { error: "no held install" });
      const held = pending;
      pending = null;
      held.release();
      return reply(200, { released: true });
    }
    if (request.method === "POST" && request.url === "/drop") {
      if (!pending?.drop)
        return reply(409, { error: "no held install response" });
      const held = pending;
      pending = null;
      held.drop();
      return reply(200, { dropped: true });
    }
    reply(404, { error: "not found" });
  }).listen(18093, "127.0.0.1");
}
