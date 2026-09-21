import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { until } from "../workspace-closeout/state.mjs";

const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
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
    failure;
  const source = new EventSource(client.base + path, {
    fetch: async (url, init) => {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, init.signal]),
        headers: {
          ...init.headers,
          Cookie: client.cookie,
          Origin: client.base,
        },
      });
      const actual = response.headers.get("x-antnest-trace-id");
      if (!response.ok || !/^[a-f0-9]{32}$/.test(actual ?? "")) {
        failure = new Error("invalid shutdown watch response identity");
        await response.body?.cancel();
        throw failure;
      }
      traceID = actual;
      return response;
    },
  });
  const close = () => {
    disposed = true;
    source.close();
    signal.removeEventListener("abort", close);
  };
  source.addEventListener(event, (received) => {
    try {
      const value = JSON.parse(received.data);
      validate(value);
      events.push(value);
      assert(events.length < 100, "unbounded shutdown watch events");
    } catch {
      failure = new Error("invalid shutdown watch event");
      close();
    }
  });
  source.addEventListener("error", () => {
    ended = true;
    source.close();
  });
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  const healthy = () => {
    if (failure) throw failure;
    assert(!disposed, "watch closed by the test");
  };
  return {
    get traceID() {
      return traceID;
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
