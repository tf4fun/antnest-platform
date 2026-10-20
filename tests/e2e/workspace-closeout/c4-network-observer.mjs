import assert from "node:assert/strict";

const freeze = (value) => {
  for (const child of Object.values(value))
    if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
};

// Observe Chromium's original network records on an independent CDP session.
// Never intercept, send, replay, or read the body of an EventSource request.
export function observeC4Network(page, { origin, path }) {
  const rows = new Map(),
    errors = [],
    tasks = new Set(),
    clockSamples = [];
  let session,
    mainFrame,
    before,
    disposed = false,
    disconnected = false,
    closing;
  const guard = (action) => (event) => {
    try {
      action(event);
    } catch (error) {
      errors.push(error);
    }
  };
  const requested = guard((event) => {
    assert(
      !rows.has(event.requestId),
      "duplicate or redirected C4 native request",
    );
    const url = new URL(event.request.url);
    if (
      url.origin !== origin ||
      url.pathname !== path ||
      event.request.method !== "GET" ||
      event.type !== "EventSource" ||
      event.frameId !== mainFrame
    )
      return;
    assert(!event.redirectResponse, "redirected C4 native request");
    rows.set(event.requestId, {
      request: {
        request_id: event.requestId,
        frame_id: event.frameId,
        loader_id: event.loaderId,
        type: event.type,
        url: event.request.url,
        method: event.request.method,
        timestamp: event.timestamp,
        wall_time: event.wallTime,
      },
    });
  });
  const responded = guard((event) => {
    const row = rows.get(event.requestId);
    if (!row) return;
    assert(!row.response, "duplicate C4 native response");
    const trace = Object.entries(event.response.headers).filter(
      ([key]) => key.toLowerCase() === "x-antnest-trace-id",
    );
    row.response = {
      request_id: event.requestId,
      frame_id: event.frameId,
      loader_id: event.loaderId,
      type: event.type,
      url: event.response.url,
      status: event.response.status,
      timestamp: event.timestamp,
      trace_id: trace.length === 1 ? trace[0][1] : null,
    };
  });
  const ended = (kind) =>
    guard((event) => {
      const row = rows.get(event.requestId);
      if (!row) return;
      assert(!row.end, "duplicate C4 native EOF");
      row.end = {
        request_id: event.requestId,
        kind,
        timestamp: event.timestamp,
        ...(kind === "loadingFailed"
          ? {
              error_text: event.errorText,
              canceled: event.canceled ?? false,
            }
          : {}),
      };
    });
  const handlers = {
    "Network.requestWillBeSent": requested,
    "Network.responseReceived": responded,
    "Network.loadingFinished": ended("loadingFinished"),
    "Network.loadingFailed": ended("loadingFailed"),
    close: () => {
      disconnected = true;
    },
  };
  function healthy() {
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "C4 native observation failed");
  }
  const sample = () => {
    const task = (async () => {
      assert(
        !disposed && !disconnected,
        "C4 native observer disposed or disconnected",
      );
      const started_at = performance.now();
      let result;
      try {
        result = await session.send("Performance.getMetrics");
      } catch (error) {
        clockSamples.push({
          started_at,
          completed_at: performance.now(),
          failed: true,
        });
        throw error;
      }
      const completed_at = performance.now();
      const values = result.metrics.filter(
        (entry) => entry.name === "Timestamp",
      );
      const sample = {
        started_at,
        completed_at,
        ...(values.length === 1
          ? { timestamp: values[0].value }
          : { timestamp_values: values.map((value) => value.value) }),
      };
      clockSamples.push(sample);
      assert.equal(
        values.length,
        1,
        "original Chromium Timestamp metric required",
      );
      healthy();
      return { ...sample };
    })();
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      (error) => {
        errors.push(error);
        tasks.delete(task);
      },
    );
    return task;
  };
  const ready = (async () => {
    session = await page.context().newCDPSession(page);
    if (disposed) return;
    for (const [name, handler] of Object.entries(handlers))
      session.on(name, handler);
    const tree = await session.send("Page.getFrameTree");
    mainFrame = tree.frameTree.frame.id;
    if (disposed) return;
    await session.send("Network.enable");
    if (disposed) return;
    await session.send("Performance.enable", { timeDomain: "timeTicks" });
    if (disposed) return;
    before = await sample();
  })();
  // The owner joins ready, including setup that fails before navigation.
  void ready.catch(() => {});
  function match(stream) {
    healthy();
    const candidates = [...rows.values()].filter(
      (row) =>
        row.request.url === stream.origin + stream.path &&
        row.response?.trace_id === stream.trace_id,
    );
    assert(candidates.length <= 1, "ambiguous C4 native request binding");
    return candidates[0];
  }
  return {
    ready,
    match,
    get records() {
      return structuredClone(
        [...rows.values()].map(({ request, response, end }) => ({
          request,
          ...(response ? { response } : {}),
          ...(end ? { end } : {}),
        })),
      );
    },
    get clockSamples() {
      return structuredClone(clockSamples);
    },
    async admission(stream) {
      await ready;
      const row = match(stream);
      assert(row && !row.end, "C4 native stream not live at checkpoint");
      assert(
        !row.bound,
        "C4 native request already bound to another page receipt",
      );
      const admission = await sample();
      assert(!row.end && !disposed, "C4 native stream ended before checkpoint");
      row.bound = true;
      return freeze({
        source: "chromium-cdp",
        main_frame_id: mainFrame,
        request: { ...row.request },
        response: { ...row.response },
        calibration: { before: { ...before }, admission },
      });
    },
    ended(stream) {
      return match(stream)?.end !== undefined;
    },
    async completion(stream) {
      const row = match(stream);
      assert(row?.bound && row.end, "original bound C4 native EOF required");
      const calibration = await sample();
      return freeze({ event: { ...row.end }, calibration });
    },
    closeAndWait() {
      return (closing ??= (async () => {
        disposed = true;
        const failures = [];
        try {
          await ready;
        } catch (error) {
          failures.push(error);
        }
        for (const result of await Promise.allSettled([...tasks]))
          if (result.status === "rejected") failures.push(result.reason);
        for (const [name, handler] of Object.entries(handlers))
          session?.off(name, handler);
        try {
          if (session && !disconnected) await session.detach();
        } catch (error) {
          if (!page.isClosed()) failures.push(error);
        }
        failures.push(...errors);
        const unique = [...new Set(failures)];
        if (unique.length === 1) throw unique[0];
        if (unique.length)
          throw new AggregateError(
            unique,
            "C4 native observation cleanup failed",
          );
      })());
    },
  };
}
