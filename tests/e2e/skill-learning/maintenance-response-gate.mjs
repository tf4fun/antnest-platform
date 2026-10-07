import { createServer } from "node:http";

// Loaded only by the disposable ACP container. One test delays the real
// Runtime receipt; another delays dispatch after ACP has recorded its intent.
// NODE_OPTIONS loads this file into every node process in the container,
// including the `node -e` healthcheck, which must not take the gate's port.
if (process.argv[1]?.endsWith("/dist/main.js")) install();

function install() {
  const originalFetch = globalThis.fetch;
  let pending = null;
  let atomicAbortSeen = false;
  let releaseHeld = false;
  globalThis.fetch = async (input, init) => {
    const address =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url;
    const url = new URL(address);
    if (process.env.ANTNEST_E2E_HOLD_RELEASE === "true") {
      if (url.pathname !== "/internal/skill-maintenance/release" || releaseHeld)
        return originalFetch(input, init);
      releaseHeld = true;
    } else if (url.pathname !== "/internal/skill-maintenance/commit") {
      return originalFetch(input, init);
    }
    if (process.env.ANTNEST_E2E_HOLD_AFTER_INSTALL === "true") {
      if (init?.signal?.aborted) atomicAbortSeen = true;
      else
        init?.signal?.addEventListener(
          "abort",
          () => {
            atomicAbortSeen = true;
          },
          { once: true },
        );
      return originalFetch(input, init);
    }
    if (process.env.ANTNEST_E2E_HOLD_BEFORE_COMMIT === "true") {
      if (pending) throw new Error("Only one maintenance dispatch may be held");
      return new Promise((resolve, reject) => {
        pending = {
          signal: init?.signal,
          release: () => {
            if (init?.signal?.aborted) {
              reject(
                init.signal.reason ?? new DOMException("Aborted", "AbortError"),
              );
            } else {
              originalFetch(input, init).then(resolve, reject);
            }
          },
        };
      });
    }
    const response = await originalFetch(input, init);
    if (!response.ok) return response;
    if (pending) throw new Error("Only one maintenance response may be held");
    const body = await response.arrayBuffer();
    const complete = new Response(body, {
      status: response.status,
      headers: response.headers,
    });
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, response: complete, signal: init?.signal };
    });
  };

  createServer((request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, {
        pending: pending !== null,
        aborted: pending?.signal?.aborted === true || atomicAbortSeen,
      });
    if (request.method === "POST" && request.url === "/release") {
      if (!pending) return reply(409, { error: "no held response" });
      const held = pending;
      pending = null;
      if (held.release) held.release();
      else held.resolve(held.response);
      return reply(200, { released: true });
    }
    if (request.method === "POST" && request.url === "/drop") {
      if (!pending) return reply(409, { error: "no held response" });
      if (pending.release)
        return reply(409, { error: "dispatch cannot be dropped" });
      const held = pending;
      pending = null;
      held.reject(new Error("Held Runtime commit response lost"));
      return reply(200, { dropped: true });
    }
    reply(404, { error: "not found" });
  }).listen(18093, "127.0.0.1");
}
