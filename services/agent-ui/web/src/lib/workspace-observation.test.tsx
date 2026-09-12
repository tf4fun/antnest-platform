import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useWorkspaceState } from "./use-workspace-state";
import { watchWorkspaceState, type StateListener, type WorkspaceState } from "./workspace-state";
import type { AgentUIClient } from "./client";
import { previewWorkspace } from "./preview";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const ready: WorkspaceState = { agent_id: "a1", availability: "ready", access_allowed: true, agent_revision: 1, active_session_id: null };

function fixture() {
  const listeners: StateListener[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const client = { loadWorkspace: vi.fn(async () => previewWorkspace()),
    watchState: vi.fn((_id: string, listener: StateListener) => { listeners.push(listener); const stop = vi.fn(); stops.push(stop); return stop; }) } as unknown as AgentUIClient;
  const onWorkspace = vi.fn();
  const view = renderHook(({ id }) => useWorkspaceState(client, id, onWorkspace), { initialProps: { id: "a1" } });
  return { ...view, client, onWorkspace, listeners, stops };
}

test("observer gates initial state, retries only after failure, refreshes access and ignores stale callbacks", async () => {
  vi.useFakeTimers();
  const f = fixture();
  expect(f.result.current.state).toBeUndefined();
  act(() => f.listeners[0]!.onState(ready));
  expect(f.result.current.state).toEqual(ready);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(f.client.loadWorkspace).not.toHaveBeenCalled();
  act(() => f.listeners[0]!.onDisconnect());
  expect(f.result.current.state).toBeUndefined();
  expect(f.stops[0]).toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(f.client.loadWorkspace).toHaveBeenCalledTimes(1);
  expect(f.onWorkspace).toHaveBeenCalledTimes(1);
  expect(f.listeners).toHaveLength(2);
  act(() => f.listeners[0]!.onState({ ...ready, availability: "busy" }));
  expect(f.result.current.state).toBeUndefined();
  act(() => f.listeners[1]!.onState(ready));
  expect(f.result.current.state).toEqual(ready);
});

test("bootstrap outage backs off without opening more streams or accepting stale readiness", async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.client.loadWorkspace).mockRejectedValue(new Error("Unavailable"));
  act(() => f.listeners[0]!.onDisconnect());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(f.client.loadWorkspace).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(f.client.loadWorkspace).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(f.client.loadWorkspace).toHaveBeenCalledTimes(2);
  expect(f.listeners).toHaveLength(1);
});

test("switch and unmount cancel retry/bootstrap, close streams and discard old Agent states", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let complete!: () => void;
  let signal!: AbortSignal;
  vi.mocked(f.client.loadWorkspace).mockImplementation(s => { signal = s!; return new Promise(resolve => { complete = () => resolve(previewWorkspace()); }); });
  act(() => f.listeners[0]!.onDisconnect());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  f.rerender({ id: "a2" });
  expect(signal.aborted).toBe(true);
  await act(async () => complete());
  expect(f.onWorkspace).not.toHaveBeenCalled();
  act(() => f.listeners[0]!.onState(ready));
  expect(f.result.current.state).toBeUndefined();
  f.unmount();
  expect(f.stops[1]).toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(f.client.loadWorkspace).toHaveBeenCalledTimes(1);
});

test("first snapshot timeout retries and explicit refresh requires fresh authoritative state", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(f.stops[0]).toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  act(() => f.listeners[1]!.onState(ready));
  act(() => f.result.current.refresh());
  expect(f.result.current.state).toBeUndefined();
  await act(async () => {});
  expect(f.client.loadWorkspace).toHaveBeenCalledTimes(2);
});

test("EventSource validates framing payload and closes before its implicit retry", async () => {
  const sources: Source[] = [];
  class Source extends EventTarget { close = vi.fn(); constructor(readonly url: string) { super(); sources.push(this); } }
  vi.stubGlobal("EventSource", Source);
  const listener = { onState: vi.fn(), onDisconnect: vi.fn() };
  const stop = watchWorkspaceState("a1", listener);
  expect(sources[0]!.url).toBe("/api/app/agents/a1/state/watch");
  sources[0]!.dispatchEvent(new MessageEvent("workspace_state", { data: JSON.stringify(ready) }));
  await waitFor(() => expect(listener.onState).toHaveBeenCalledWith(ready));
  sources[0]!.dispatchEvent(new Event("error"));
  expect(sources[0]!.close).toHaveBeenCalled();
  expect(listener.onDisconnect).toHaveBeenCalledTimes(1);
  sources[0]!.dispatchEvent(new MessageEvent("workspace_state", { data: JSON.stringify(ready) }));
  expect(listener.onState).toHaveBeenCalledTimes(1);
  stop();
});

test("observation without an Agent is inert and access-loss snapshot does not retry", async () => {
  vi.useFakeTimers();
  const client = { watchState: vi.fn(), loadWorkspace: vi.fn() } as unknown as AgentUIClient;
  const view = renderHook(() => useWorkspaceState(client, undefined, vi.fn()));
  expect(view.result.current.state).toBeUndefined();
  expect(client.watchState).not.toHaveBeenCalled();
  const f = fixture();
  act(() => f.listeners[0]!.onState({ ...ready, access_allowed: false, availability: "offline" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(f.result.current.state?.access_allowed).toBe(false);
  expect(f.client.loadWorkspace).not.toHaveBeenCalled();
});

test("A to B to A cannot revive a snapshot owned by a disposed subscription", () => {
  const f = fixture();
  act(() => f.listeners[0]!.onState(ready));
  f.rerender({ id: "a2" });
  expect(f.result.current.state).toBeUndefined();
  f.rerender({ id: "a1" });
  expect(f.result.current.state).toBeUndefined();
  act(() => f.listeners[0]!.onState(ready));
  expect(f.result.current.state).toBeUndefined();
  act(() => f.listeners[2]!.onState(ready));
  expect(f.result.current.state).toEqual(ready);
});
