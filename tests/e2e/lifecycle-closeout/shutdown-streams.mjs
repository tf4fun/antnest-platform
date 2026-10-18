import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import { until } from "../workspace-closeout/state.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { EventSource } = require("eventsource");

function fail(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(unique, "Shutdown watch cleanup failed");
}

export async function openShutdownWatchSet(
  definitions,
  open = openShutdownWatch,
) {
  const watches = [];
  try {
    for (const args of definitions) watches.push(await open(...args));
    return watches;
  } catch (error) {
    const errors = [error];
    for (const watch of watches) {
      try {
        watch.close();
      } catch (error) {
        errors.push(error);
      }
    }
    const joined = await Promise.allSettled(
      watches.map((watch) => watch.closeAndWait()),
    );
    for (const result of joined)
      if (result.status === "rejected") errors.push(result.reason);
    fail(errors);
  }
}

export function openShutdownWatch(
  client,
  path,
  event,
  validate,
  signal,
  { fetchImpl = fetch } = {},
) {
  const events = [];
  const pending = new Set(),
    readers = [],
    errors = [];
  const remoteReadErrors = new Map();
  const ownAbort = new AbortController();
  const localReason = new Error("Shutdown public watch closed locally");
  let joining;
  const track = (promise) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const retain = (error, bounded) => {
    if (
      error === localReason ||
      (bounded?.aborted &&
        error === bounded.reason &&
        closure?.kind !== "global-abort")
    )
      return;
    errors.push(error);
  };
  const retainRead = (error, entry) => {
    if (
      !disposed &&
      !signal.aborted &&
      traceID &&
      events.length > 0 &&
      entry.validIdentity &&
      error instanceof TypeError &&
      error.message === "terminated" &&
      error.cause?.code === "UND_ERR_SOCKET" &&
      error.cause?.message === "other side closed" &&
      !remoteReadErrors.has(error)
    )
      remoteReadErrors.set(error, {
        traceID,
        observedAt: Date.now(),
        name: error.name,
        message: error.message,
        cause_code: error.cause.code,
        cause_message: error.cause.message,
        reason: "shutdown-public-remote-socket-end",
        raw_error: inspect(error, { depth: 8 }),
      });
    retain(error, entry.signal);
  };
  const transportErrors = () =>
    new Map(
      [...remoteReadErrors].filter(
        ([, row]) =>
          closure?.kind === "transport-end" &&
          row.observedAt <= closure.observedAt,
      ),
    );
  const cancel = (entry) =>
    (entry.cancelled ??= track(
      Promise.resolve()
        .then(() => entry.reader.cancel(localReason))
        .catch((error) => retain(error, entry.signal)),
    ));
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
    fetch: (url, init) =>
      track(
        (async () => {
          const bounded = AbortSignal.any(
            [signal, init.signal, ownAbort.signal].filter(Boolean),
          );
          let entry;
          try {
            const response = await fetchImpl(url, {
              ...init,
              signal: bounded,
              headers: {
                ...init.headers,
                Cookie: client.cookie,
                Origin: gatewayOrigin(client.base),
              },
            });
            if (response.body) {
              entry = {
                reader: response.body.getReader(),
                signal: bounded,
                proxyCancelled: false,
              };
              readers.push(entry);
              track(
                entry.reader.closed.catch((error) => retainRead(error, entry)),
              );
            }
            if (disposed || ended) {
              if (entry) await cancel(entry);
              throw localReason;
            }
            const actual = response.headers.get("x-antnest-trace-id");
            if (!response.ok || !/^[a-f0-9]{32}$/.test(actual ?? "")) {
              failure = new Error("invalid shutdown watch response identity");
              observeClosure("invalid-response");
              if (entry) await cancel(entry);
              throw failure;
            }
            traceID = actual;
            assert(entry, "shutdown watch response body missing");
            entry.validIdentity = true;
            const body = new ReadableStream({
              async pull(controller) {
                try {
                  const part = await track(entry.reader.read());
                  if (entry.proxyCancelled) return;
                  if (part.done) controller.close();
                  else controller.enqueue(part.value);
                } catch (error) {
                  retainRead(error, entry);
                  if (!entry.proxyCancelled) controller.error(error);
                }
              },
              cancel() {
                entry.proxyCancelled = true;
                return cancel(entry);
              },
            });
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          } catch (error) {
            retain(error, bounded);
            throw error;
          }
        })(),
      ),
  });
  const dispose = (kind) => {
    observeClosure(kind);
    disposed = true;
    ownAbort.abort(localReason);
    source.close();
    for (const entry of readers) cancel(entry);
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
    } catch (error) {
      failure = new Error("invalid shutdown watch event", { cause: error });
      errors.push(failure);
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
  const closeAndWait = () =>
    (joining ??= (async () => {
      close();
      while (pending.size) await Promise.allSettled([...pending]);
      for (const entry of readers) {
        try {
          entry.reader.releaseLock();
        } catch (error) {
          errors.push(error);
        }
      }
      const remote = transportErrors();
      const failures = errors.filter((error) => !remote.has(error));
      if (signal.aborted) failures.push(signal.reason);
      fail(failures);
      return closure;
    })());
  return {
    get transportErrors() {
      return [...transportErrors().keys()];
    },
    get transportDiagnostics() {
      return structuredClone([...transportErrors().values()]);
    },
    get traceID() {
      return traceID;
    },
    get closure() {
      return closure;
    },
    events,
    close,
    closeAndWait,
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
