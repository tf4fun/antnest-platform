import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { assertState } from "./evidence.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { EventSource } = require("eventsource");

export async function until(read, label, signal, timeout = 15000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    signal?.throwIfAborted();
    const value = await read();
    if (value) return value;
    await delay(100, undefined, { signal });
  }
  throw new Error(`${label} did not converge`);
}

export function observeState(client, agentID, signal) {
  const states = [];
  let traceID, clock, closure;
  let ended = false,
    failure;
  const source = new EventSource(
    `${client.base}/api/app/agents/${agentID}/state/watch`,
    {
      fetch: async (url, init) => {
        const requestStartedAt = Date.now();
        const response = await fetch(url, {
          ...init,
          signal: signal ? AbortSignal.any([signal, init.signal]) : init.signal,
          headers: {
            ...init.headers,
            Cookie: client.cookie,
            Origin: gatewayOrigin(client.base),
          },
        });
        clock = Object.freeze({
          requestStartedAt,
          responseReceivedAt: Date.now(),
          serverDate: response.headers.get("date"),
        });
        const actual = response.headers.get("x-antnest-trace-id");
        if (!response.ok || !/^[a-f0-9]{32}$/.test(actual ?? "")) {
          failure = new Error("invalid Workspace watch response identity");
          await response.body?.cancel();
          throw failure;
        }
        traceID = actual;
        return response;
      },
    },
  );
  const close = (kind) => {
    closure ??= Object.freeze({ traceID, kind, observedAt: Date.now() });
    source.close();
    ended = true;
    signal?.removeEventListener("abort", aborted);
  };
  const aborted = () => close("aborted");
  source.addEventListener("workspace_state", (event) => {
    try {
      assert(!event.lastEventId, "state watch must not add a replay cursor");
      const state = JSON.parse(event.data);
      assertState(state, agentID);
      states.push(state);
      assert(states.length < 100, "state watch produced unbounded changes");
      if (!state.access_allowed) close("access-denied");
    } catch (error) {
      failure = error;
      close("invalid-state");
    }
  });
  source.addEventListener("error", () => close("transport-end"));
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  return {
    states,
    get traceID() {
      return traceID;
    },
    get clock() {
      return clock;
    },
    get closure() {
      return closure;
    },
    close: () => close("local-close"),
    assertOpen: () => {
      if (failure) throw failure;
      assert(!ended && states.length > 0, "state observer is not live");
    },
    wait: (predicate, after = 0) =>
      until(
        () => {
          if (failure) throw failure;
          const state = states.slice(after).find(predicate);
          if (!state && ended)
            throw new Error("State watch ended before expected state");
          return state;
        },
        "workspace state",
        signal,
      ),
    waitClosed: () =>
      until(
        () => {
          if (failure) throw failure;
          return ended;
        },
        "workspace watch closure",
        signal,
      ),
  };
}
