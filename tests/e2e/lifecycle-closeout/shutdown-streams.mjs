import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { until } from "../workspace-closeout/state.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { EventSource } = require("eventsource");

export function openShutdownWatchSet(definitions, open = openShutdownWatch) {
  const watches = [];
  try {
    for (const args of definitions) watches.push(open(...args));
    return watches;
  } catch (error) {
    for (const watch of watches) watch.close();
    throw error;
  }
}

export function openShutdownWatch(client, path, event, validate, signal) {
  const events = [];
  let traceID;
  let ended = false,
    disposed = false,
    failure,
    closure;
  const observeClosure = (kind) => {
    closure ??= Object.freeze({
      kind,
      traceID,
      observedAt: Date.now(),
      receivedEvents: events.length,
    });
  };
  const source = new EventSource(client.base + path, {
    fetch: async (url, init) => {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, init.signal]),
        headers: {
          ...init.headers,
          Cookie: client.cookie,
          Origin: gatewayOrigin(client.base),
        },
      });
      const actual = response.headers.get("x-antnest-trace-id");
      if (!response.ok || !/^[a-f0-9]{32}$/.test(actual ?? "")) {
        failure = new Error("invalid shutdown watch response identity");
        observeClosure("invalid-response");
        await response.body?.cancel();
        throw failure;
      }
      traceID = actual;
      return response;
    },
  });
  const dispose = (kind) => {
    observeClosure(kind);
    disposed = true;
    source.close();
    signal.removeEventListener("abort", abort);
  };
  const close = () => dispose("local-close");
  const abort = () => dispose("global-abort");
  source.addEventListener(event, (received) => {
    try {
      const value = JSON.parse(received.data);
      validate(value);
      events.push(value);
      assert(events.length < 100, "unbounded shutdown watch events");
    } catch {
      failure = new Error("invalid shutdown watch event");
      dispose("invalid-event");
    }
  });
  source.addEventListener("error", () => {
    if (disposed) return;
    observeClosure("transport-end");
    ended = true;
    source.close();
    // EventSource schedules its reconnect timer after dispatching this event.
    // Close synchronously to stop reads, then clear that post-dispatch timer.
    queueMicrotask(() => source.close());
    signal.removeEventListener("abort", abort);
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const healthy = () => {
    if (failure) throw failure;
    assert(!disposed, "watch closed by the test");
  };
  return {
    get traceID() {
      return traceID;
    },
    get closure() {
      return closure;
    },
    events,
    close,
    ready: () =>
      until(
        () => {
          healthy();
          assert(!ended, "watch ended before initial event");
          return events.length > 0;
        },
        "initial watch event",
        signal,
      ),
    assertOpen: () => {
      healthy();
      assert(!ended && events.length > 0, "watch is not live");
    },
    waitClosed: () =>
      until(
        () => {
          healthy();
          return ended;
        },
        "remote watch closure",
        signal,
      ),
  };
}
