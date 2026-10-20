import assert from "node:assert/strict";

export function c4BootstrapDenial(page, response, gateway, lastCompletedCheck) {
  const url = new URL(response.url());
  if (
    response.status() !== 401 ||
    url.origin !== new URL(gateway).origin ||
    url.pathname !== "/api/app/workspace/v1/bootstrap" ||
    url.search ||
    url.hash
  )
    return null;
  const request = response.request();
  if (
    request.method() !== "GET" ||
    request.frame() !== page.mainFrame() ||
    request.url() !== url.href ||
    request.redirectedFrom() !== null
  )
    return null;
  const traceID = response.headers()["x-antnest-trace-id"];
  assert(
    /^(?!0{32}$)[a-f0-9]{32}$/u.test(traceID ?? ""),
    "original bootstrap denial Trace ID required",
  );
  // Authentication recovery navigates from the page itself. The browser SDK
  // cannot promise the old body's lifetime across that navigation. Keep the
  // original HTTP identity; this body is explicitly outside the payload audit.
  return {
    url: url.href,
    method: "GET",
    status: 401,
    traceID,
    lastCompletedCheck,
    body: "not_observed_during_auth_navigation",
  };
}

export async function beforeC4Responses(readers, action) {
  for (;;) {
    await Promise.all(readers.map((reader) => reader.wait()));
    // A response may arrive in another page, or in a microtask after an empty
    // drain. The final check and page change must share one synchronous turn.
    if (readers.every((reader) => reader.ready())) return action();
  }
}

export function observeC4Responses(page, scope, capture) {
  const pending = new Set(),
    failures = new Set();
  const receive = (response) => {
    const url = new URL(response.url());
    // SSE watches have no finite response body.
    if (
      url.pathname.startsWith("/api/app/") &&
      !url.pathname.endsWith("/watch") &&
      !url.pathname.endsWith("/events") &&
      !response.headers()["content-type"]?.startsWith("text/event-stream")
    ) {
      // Register the read with both owners immediately. Navigation waiters and
      // SSE observers belong to the browser scope, never to this finite group.
      const read = scope.track((async () => capture(response, url))());
      const joined = read.then(
        () => {},
        (error) => {
          failures.add(error);
        },
      );
      pending.add(joined);
      void joined.then(() => pending.delete(joined));
    }
  };
  page.on("response", receive);
  const ready = () => {
    // Settled errors must still block navigation. The scope retains every
    // original error and joins other readers when closing after a failure.
    if (failures.size) throw failures.values().next().value;
    return pending.size === 0;
  };
  const wait = async () => {
    while (pending.size) await Promise.all([...pending]);
    ready();
  };
  scope.addObserver({
    async closeAndWait() {
      page.off("response", receive);
      await wait();
    },
  });
  const reader = {
    wait,
    ready,
    before: (action) => beforeC4Responses([reader], action),
  };
  return reader;
}
