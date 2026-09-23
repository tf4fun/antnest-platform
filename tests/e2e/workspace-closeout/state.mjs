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
  let traceID;
  let ended = false,
    failure;
  const source = new EventSource(
    `${client.base}/api/app/agents/${agentID}/state/watch`,
    {
      fetch: async (url, init) => {
        const response = await fetch(url, {
          ...init,
          signal: signal ? AbortSignal.any([signal, init.signal]) : init.signal,
          headers: {
            ...init.headers,
            Cookie: client.cookie,
            Origin: client.base,
          },
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
  const close = () => {
    source.close();
    ended = true;
    signal?.removeEventListener("abort", close);
  };
  source.addEventListener("workspace_state", (event) => {
    try {
      assert(!event.lastEventId, "state watch must not add a replay cursor");
      const state = JSON.parse(event.data);
      assertState(state, agentID);
      states.push(state);
      assert(states.length < 100, "state watch produced unbounded changes");
      if (!state.access_allowed) close();
    } catch (error) {
      failure = error;
      close();
    }
  });
  source.addEventListener("error", () => close());
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();
  return {
    states,
    get traceID() {
      return traceID;
    },
    close,
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
