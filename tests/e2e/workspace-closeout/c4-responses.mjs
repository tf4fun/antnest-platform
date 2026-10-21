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
    // A request may arrive in another page, or in a microtask after an empty
    // drain. The final check and page change must share one synchronous turn.
    if (readers.every((reader) => reader.ready())) return action();
  }
}

export function observeC4Responses(page, scope, capture) {
  const pending = new Set(),
    failures = new Set(),
    requests = new Map();
  const finite = (url) =>
    url.pathname.startsWith("/api/app/") &&
    !url.pathname.endsWith("/watch") &&
    !url.pathname.endsWith("/events");
  const settle = (request, state) => {
    if (!state.terminal || !state.bodyDone) return;
    requests.delete(request);
    pending.delete(state.promise);
    state.resolve();
  };
  const issued = (request) => {
    if (!finite(new URL(request.url()))) return;
    let state = requests.get(request);
    if (!state) {
      const completion = Promise.withResolvers();
      state = { ...completion, terminal: false, bodyDone: true };
      requests.set(request, state);
      pending.add(state.promise);
    }
    return state;
  };
  const terminal = (request) => {
    const state = requests.get(request);
    if (state) {
      state.terminal = true;
      settle(request, state);
    }
  };
  const receive = (response) => {
    const url = new URL(response.url());
    if (!finite(url)) return;
    const request = response.request();
    const state = issued(request);
    // An unrecognized stream route is finite only until its headers identify
    // SSE. Its lifetime belongs to the stream observer, not this drain.
    if (response.headers()["content-type"]?.startsWith("text/event-stream")) {
      terminal(request);
      return;
    }
    state.bodyDone = false;
    const read = scope.track((async () => capture(response, url))());
    const complete = () => {
      state.bodyDone = true;
      settle(request, state);
    };
    void read.then(complete, (error) => {
      failures.add(error);
      complete();
    });
  };
  const closed = () => {
    page.off("request", issued);
    page.off("response", receive);
    page.off("requestfinished", terminal);
    page.off("requestfailed", terminal);
    page.off("close", closed);
    // Closure can precede a requestfailed event. Release requests that never
    // had a response, while joining every body read already registered.
    for (const request of requests.keys()) terminal(request);
  };
  // Register before headers arrive: response-only tracking lets navigation
  // overtake an already-issued request and invalidate its later body read.
  page.on("request", issued);
  page.on("response", receive);
  page.on("requestfinished", terminal);
  page.on("requestfailed", terminal);
  page.on("close", closed);
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
      closed();
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
