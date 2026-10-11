import {
  applyBridgeEvent,
  bridgeViewForScope,
  initialBridgeStream,
  type BridgeAgentView,
} from "./bridge-stream.ts";
import type { BridgeHttpClient } from "./workspace-api-client.ts";
import { BrowserSessionChanged } from "./browser-session.ts";

type ObserverApi = Pick<BridgeHttpClient, "agentView" | "eventsURL" | "sessionCurrent" | "onSessionCancelled">;

export async function openBridgeObserver(input: {
  api: ObserverApi;
  agentId: string;
  sessionId: string | null;
  sourceFactory?: (url: string) => EventSource;
  signal?: AbortSignal;
  onView(view: BridgeAgentView): void;
  onConnected?(): void;
  onResync(): void;
  onRevoked(): void;
  onDisconnect(): void;
}): Promise<() => void> {
  input.signal?.throwIfAborted();
  const initial = bridgeViewForScope(
    await input.api.agentView(input.agentId, input.sessionId, input.signal),
    input.agentId,
    input.sessionId,
  );
  input.signal?.throwIfAborted();
  if (!input.api.sessionCurrent()) throw new BrowserSessionChanged();
  if (initial === null)
    throw new Error("Workspace View does not match the selected Agent and Session");
  input.onView(initial);
  if (!input.api.sessionCurrent()) throw new BrowserSessionChanged();
  let state = { ...initialBridgeStream(input.agentId, input.sessionId), view: initial as BridgeAgentView | null };
  const source = (input.sourceFactory ?? ((url) => new EventSource(url)))(
    input.api.eventsURL(input.agentId, input.sessionId, initial.streamCursor),
  );
  let closed = false;
  let detachSession = () => {};
  const stop = () => {
    if (closed) return;
    closed = true;
    input.signal?.removeEventListener("abort", stop);
    detachSession();
    source.close();
  };
  try { detachSession = input.api.onSessionCancelled(stop); }
  catch (cause) { stop(); throw cause; }
  if (closed) detachSession();
  input.signal?.addEventListener("abort", stop, { once: true });
  if (input.signal?.aborted) stop();
  const current = () => {
    if (closed) return false;
    if (!input.api.sessionCurrent()) { stop(); return false; }
    return true;
  };
  source.addEventListener("open", () => {
    if (current()) input.onConnected?.();
  });
  for (const name of ["snapshot", "reset", "delta", "access_revoked"]) {
    source.addEventListener(name, (event) => {
      if (!current()) return;
      let raw: unknown;
      try {
        const data = (event as MessageEvent<string>).data;
        if (typeof data !== "string" || data.length > 1_048_576)
          throw new Error("Workspace event exceeds the client limit");
        raw = JSON.parse(data);
      } catch {
        stop();
        input.onResync();
        return;
      }
      const result = applyBridgeEvent(state, raw);
      state = result.state;
      switch (result.action) {
        case "view":
          input.onView(result.state.view!);
          return;
        case "ignore":
          return;
        case "refresh":
          stop();
          input.onResync();
          return;
        case "revoke":
          stop();
          input.onRevoked();
          return;
      }
    });
  }
  source.addEventListener("error", () => {
    if (!current()) return;
    stop();
    input.onDisconnect();
  });
  return stop;
}
