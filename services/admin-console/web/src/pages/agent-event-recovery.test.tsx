import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentEvent, LifecycleOperation } from "../lib/types";
import { AgentsPage } from "./agents";
import { savePendingNetwork, readPendingNetwork } from "../lib/network-policy";

declare const jsdom: { window: Window };
const networkScope = JSON.stringify(["org-1", "admin-1"]);
beforeEach(() => { vi.stubGlobal("localStorage", jsdom.window.localStorage); });

afterEach(() => {
  cleanup();
  expect(vi.mocked(globalThis.fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  vi.useRealTimers();
  window.location.hash = "";
  sessionStorage.clear();
  window.localStorage.clear();
});

const timestamp = "2026-09-10T00:00:00Z";
const agent: Agent = {
  agent_id: "agent-1", owner_user_id: "user-1", name: "Support Agent",
  desired_state: "enabled", lifecycle_state: "created", activation_state: "enabled", runtime_state: "unknown", aggregate_sequence: 1,
  agent_spec_revision: "spec-1", runtime: { runtime_revision: "runtime-1" }, executable_execution_revision: "execution-1",
  active_operation_request_id: "create-1", created_at: timestamp, updated_at: timestamp,
};
const operation: LifecycleOperation = {
  request_id: "create-1", agent_id: agent.agent_id, kind: "create",
  phase: "runtime_initialize", state: "running", created_at: timestamp, updated_at: timestamp,
};

function event(global: number, aggregate: number, type = "agent_create_requested"): AgentEvent {
  return {
    event_id: `event-${global}`, global_sequence: global, aggregate_sequence: aggregate,
    schema_version: 1, agent_id: agent.agent_id, event_type: type,
    operation_request_id: operation.request_id, occurred_at: timestamp,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function workflow(networkFailure = false) {
  const state = {
    agent,
    agentRead: async () => Response.json(state.agent),
    operation,
    replay: async () => Response.json({ events: [], next_sequence: 101 }),
    operationRead: async () => Response.json(state.operation),
    networkRead: async () => networkFailure ? Response.json({message:"Network policy unavailable"},{status:503}) : Response.json({ agent_id: "agent-1", action: "deny_all", resource_version: 7, attachment: { state: "open", resource_version: 4 } }),
  };
  const streams: TestEventSource[] = [];
  class TestEventSource extends EventTarget {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(readonly url: string) { super(); streams.push(this); }
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    const url = new URL(input, "http://localhost");
    if (init.method === "GET" && url.pathname.endsWith("/network-policy")) return state.networkRead();
    switch (url.pathname) {
      case "/api/admin/agents/agent-1": return state.agentRead();
      case "/api/admin/operations/create-1": return state.operationRead();
      case "/api/admin/agents/agent-1/events":
        if (url.searchParams.get("after_sequence") === "0") {
          return Response.json({ events: [event(101, 1)], next_sequence: 101 });
        }
        return state.replay();
      case "/api/admin/templates": return Response.json({ items: [] });
      case "/api/admin/directory": return Response.json({ users: [], groups: [] });
      default: throw new Error(`Unexpected request: ${url.pathname}`);
    }
  });
  vi.stubGlobal("fetch", fetch);
  const page = render(<AgentsPage agentID={agent.agent_id} networkScope={networkScope} />);
  await screen.findByText("runtime initialize");
  expect(screen.getByRole("link", { name: "Execution history" }).getAttribute("href"))
    .toBe("#audits?agent_id=agent-1");
  await waitFor(() => expect(streams).toHaveLength(1));
  act(() => streams[0]!.onopen?.());
  const calls = (path: string) => fetch.mock.calls.filter(([url]) => url.split("?")[0] === path);
  return { state, streams, page, calls };
}

const eventsPath = "/api/admin/agents/agent-1/events";
const agentPath = "/api/admin/agents/agent-1";

describe("Agent event recovery", () => {
  it("refreshes Runtime conditions independently of a completed creation", async () => {
    const { state, streams } = await workflow();
    state.operation = { ...operation, state: "completed", phase: "completed" };
    state.agent = { ...agent, active_operation_request_id: undefined, executable_execution_revision: undefined };
    const conditions = [
      ["waiting", "runtime_starting", "Runtime has not completed initialization"],
      ["unhealthy", "runtime_unhealthy", "Health check failed"],
      ["exited", "runtime_exited", "Process exited with code 1"],
    ];
    for (const [index, [runtime_state, runtime_reason, runtime_detail]] of conditions.entries()) {
      state.agent = { ...state.agent, aggregate_sequence: index + 2, runtime_state: runtime_state!, runtime_reason, runtime_detail, runtime_observed_at: timestamp };
      await act(async () => streams[0]!.dispatchEvent(new MessageEvent("agent_event", {
        data: JSON.stringify({ ...event(110 + index, index + 2, "agent_runtime_condition_changed"), operation_request_id: undefined }),
      })));
      expect(await screen.findByText(runtime_detail!)).toBeTruthy();
      expect(screen.getAllByText(runtime_state!, { exact: true }).length).toBeGreaterThan(0);
      expect(screen.getByRole("heading", { name: "Last operation" })).toBeTruthy();
      expect(screen.getByText("completed", { exact: true })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it.each(["live", "reconnect"])("refreshes %s runtime loss without mistaking old completed creation for recovery", async (source) => {
    const { state, streams, calls } = await workflow();
    state.agent = { ...agent, aggregate_sequence: 3, lifecycle_state: "created", activation_state: "enabled", runtime_state: "available", active_operation_request_id: undefined };
    state.operation = { ...operation, state: "completed", phase: "completed" };
    await act(async () => streams[0]!.dispatchEvent(new MessageEvent("agent_event", { data: JSON.stringify(event(110, 3, "agent_ready")) })));
    await screen.findByRole("button", { name: "Disable" });
    state.agent = { ...state.agent, aggregate_sequence: 4, runtime_state: "absent", executable_execution_revision: undefined, failure_code: "runtime_missing", agent_spec_revision: "spec-old", last_successful_execution_revision: "execution-old" };
    const lost = { ...event(111, 4, "agent_runtime_missing"), operation_request_id: undefined };
    if (source === "live") {
      await act(async () => streams[0]!.dispatchEvent(new MessageEvent("agent_event", { data: JSON.stringify(lost) })));
    } else {
      state.replay = async () => Response.json({ events: [lost], next_sequence: 111 });
      await act(async () => streams[0]!.onerror?.());
    }
    expect(await screen.findByText("Runtime missing")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("The runtime is missing");
    expect(screen.getByRole("heading", { name: "Last operation" })).toBeTruthy();
    expect(screen.getByText("completed", { exact: true })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    // No templates are returned by this fixture: eligibility alone cannot submit.
    expect((screen.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls(agentPath).length).toBeGreaterThanOrEqual(3);
  });
  it("rereads authoritative progress after replay completes an operation observed running by the first refresh", async () => {
    const { state, streams, calls } = await workflow();
    const replay = deferred<Response>();
    state.replay = () => replay.promise;
    await act(async () => streams[0]!.onerror?.());
    expect(calls(agentPath)).toHaveLength(2);
    expect(screen.getByText("running", { exact: true })).toBeTruthy();
    state.agent = { ...agent, aggregate_sequence: 3, lifecycle_state: "created", activation_state: "enabled", runtime_state: "available", active_operation_request_id: undefined };
    state.operation = { ...operation, state: "completed", phase: "completed" };
    await act(async () => replay.resolve(Response.json({ events: [event(113, 3, "agent_ready")], next_sequence: 113 })));
    expect(await screen.findByText("completed", { exact: true })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Last operation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lifecycle change in progress" })).toBeNull();
    expect((screen.getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls(agentPath)).toHaveLength(3);
  });
  it("refreshes network policy after reconnect even when the Agent snapshot is unchanged, without acknowledging a pending write", async () => {
    const intent={action:"allow_all" as const,expected_resource_version:7,idempotency_key:"pending-network-request"};
    savePendingNetwork(window.localStorage,networkScope,agent.agent_id,intent);
    const {state,streams,calls}=await workflow();
    await waitFor(()=>expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
    state.networkRead=async()=>Response.json({agent_id:"agent-1",action:"allow_all",resource_version:8,attachment:{state:"open",resource_version:4}});
    vi.useFakeTimers();
    await act(async()=>streams[0]!.onerror?.());
    await act(async()=>vi.advanceTimersByTimeAsync(1000));
    await act(async()=>streams[1]!.onopen?.());
    vi.useRealTimers();
    await waitFor(()=>expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(calls("/api/admin/agents/agent-1/network-policy")).toHaveLength(2);
    expect(screen.getByRole("button",{name:"Retry network update"})).toBeTruthy();
    expect(readPendingNetwork(window.localStorage,networkScope,agent.agent_id)).toEqual(intent);
    expect(screen.queryByText("Network policy saved.")).toBeNull();
  });

  it("refreshes network on a successful reopened stream after both recovery reads failed offline", async () => {
    const {state,streams,calls}=await workflow();
    state.agentRead=async()=>{throw new TypeError("Offline");};
    state.replay=async()=>{throw new TypeError("Offline");};
    vi.useFakeTimers();
    await act(async()=>streams[0]!.onerror?.());
    state.networkRead=async()=>Response.json({agent_id:"agent-1",action:"allow_all",resource_version:8,attachment:{state:"open",resource_version:4}});
    state.replay=async()=>Response.json({events:[],next_sequence:101});
    await act(async()=>vi.advanceTimersByTimeAsync(2000));
    expect(streams).toHaveLength(2);
    await act(async()=>streams[1]!.onopen?.());
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(calls("/api/admin/agents/agent-1/network-policy")).toHaveLength(2);
    expect(calls(agentPath)).toHaveLength(3);
  });

  it("keeps Agent detail and lifecycle progress when network loading fails, retrying only that read", async () => {
    const {state,calls}=await workflow(true);
    await screen.findByText("Network policy unavailable");
    expect(screen.getByRole("heading",{name:"Support Agent"})).toBeTruthy();
    expect(screen.getByRole("heading",{name:"Current operation"})).toBeTruthy();
    const agentReads=calls(agentPath).length;
    state.networkRead=async()=>Response.json({agent_id:"agent-1",action:"deny_all",resource_version:7,attachment:{state:"open",resource_version:4}});
    fireEvent.click(screen.getByRole("button",{name:"Refresh network policy"}));
    await waitFor(()=>expect(screen.queryByText("Network policy unavailable")).toBeNull());
    expect(calls(agentPath)).toHaveLength(agentReads);
    expect(calls("/api/admin/agents/agent-1/network-policy")).toHaveLength(2);
  });

  it("treats a terminal event as a hint, not as the operation's authoritative state", async () => {
    const { state, streams } = await workflow();
    await act(async () => streams[0]!.dispatchEvent(new MessageEvent("agent_event", {
      data: JSON.stringify(event(107, 2, "agent_ready")),
    })));
    const panel = within(screen.getByRole("heading", { name: "Current operation" }).closest("section")!);
    expect(panel.getByText("running", { exact: true })).toBeTruthy();
    expect(panel.queryByText("completed", { exact: true })).toBeNull();
    // The Agent projection deliberately lags; only the operation GET changes.
    state.operation = { ...operation, state: "failed", error_detail: "Runtime startup failed" };
    state.replay = async () => Response.json({ events: [], next_sequence: 107 });
    await act(async () => streams[0]!.onerror?.());
    expect(panel.getByText("failed", { exact: true })).toBeTruthy();
    expect(panel.getByText("Runtime startup failed")).toBeTruthy();
    expect(panel.queryByText("running", { exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Lifecycle change in progress" }).getAttribute("disabled")).not.toBeNull();
  });

  it("replays from the last global cursor and converges to the authoritative failed operation", async () => {
    const { state, streams, page, calls } = await workflow();
    const progress = event(107, 2, "agent_runtime_prepared");
    await act(async () => streams[0]!.dispatchEvent(new MessageEvent("agent_event", { data: JSON.stringify(progress) })));
    expect(screen.getAllByText("Event 2")).toHaveLength(1);
    expect(screen.queryByText("completed", { exact: true })).toBeNull();
    state.agent = { ...agent, aggregate_sequence: 3, lifecycle_state: "not_created", activation_state: undefined, runtime: undefined, agent_spec_revision: undefined, executable_execution_revision: undefined, active_operation_request_id: undefined };
    state.operation = { ...operation, state: "failed", error_code: "runtime_initialize_failed", error_detail: "Runtime image unavailable" };
    // The overlap models at-least-once delivery; global and per-Agent cursors differ.
    state.replay = async () => Response.json({ events: [progress, event(113, 3, "agent_build_failed")], next_sequence: 113 });
    await act(async () => { streams[0]!.onerror?.(); streams[0]!.onerror?.(); });
    expect(streams[0]!.close).toHaveBeenCalled();
    expect(calls(eventsPath).map(([url]) => new URL(url, "http://localhost").searchParams.get("after_sequence"))).toEqual(["0", "107"]);
    await screen.findByText("Runtime image unavailable");
    expect(screen.getByRole("heading", { name: "Last operation" })).toBeTruthy();
    const panel = within(screen.getByRole("heading", { name: "Last operation" }).closest("section")!);
    expect(panel.getByText("failed", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Current operation" })).toBeNull();
    for (const sequence of [1, 2, 3]) expect(screen.getAllByText(`Event ${sequence}`)).toHaveLength(1);
    expect(streams).toHaveLength(2);
    expect(streams[1]!.url).toContain("after_sequence=113");
    page.unmount();
    for (const stream of streams) expect(stream.close).toHaveBeenCalled();
  });

  it("retries failed replay after 503, then refreshes the Agent once without resubmitting a mutation", async () => {
    const { state, streams, calls } = await workflow();
    vi.useFakeTimers();
    state.replay = async () => Response.json({ message: "Event journal unavailable" }, { status: 503 });
    await act(async () => streams[0]!.onerror?.());
    expect(screen.getByRole("alert").textContent).toContain("Event journal unavailable");
    expect(screen.getByText("Event 1")).toBeTruthy();
    const agentReads = calls(agentPath).length;
    state.replay = async () => Response.json({ events: [], next_sequence: 101 });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(calls(eventsPath)).toHaveLength(3);
    expect(calls(agentPath)).toHaveLength(agentReads + 1);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(streams).toHaveLength(2);
    expect(streams[1]!.url).toContain("after_sequence=101");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(calls(eventsPath)).toHaveLength(3);
    expect(calls(agentPath)).toHaveLength(agentReads + 1);
  });

  it.each([403, 404, 410])("stops automatic recovery after terminal %s and keeps loaded evidence", async (status) => {
    const { state, streams, calls } = await workflow();
    vi.useFakeTimers();
    state.replay = async () => Response.json({ message: "Event history inaccessible" }, { status });
    await act(async () => streams[0]!.onerror?.());
    expect(screen.getByText("Event 1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Current operation" })).toBeTruthy();
    expect(screen.getByText("unavailable", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry lifecycle events" })).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(calls(eventsPath)).toHaveLength(2);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.close).toHaveBeenCalled();
  });

  it("does not reopen a stream when an in-flight replay finishes after unmount", async () => {
    const { state, streams, page, calls } = await workflow();
    vi.useFakeTimers();
    const replay = deferred<Response>();
    state.replay = () => replay.promise;
    await act(async () => streams[0]!.onerror?.());
    page.unmount();
    await act(async () => replay.resolve(Response.json({ events: [event(115, 2, "agent_ready")], next_sequence: 115 })));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(calls(eventsPath)).toHaveLength(2);
    expect(streams).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the replay retry timer on unmount", async () => {
    const { state, streams, page, calls } = await workflow();
    vi.useFakeTimers();
    state.replay = async () => Response.json({ message: "Unavailable" }, { status: 503 });
    await act(async () => streams[0]!.onerror?.());
    page.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(calls(eventsPath)).toHaveLength(2);
    expect(streams).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers an operation read independently, without replaying events or resubmitting create", async () => {
    const { state, streams, calls } = await workflow();
    state.agent = { ...agent, aggregate_sequence: 2 };
    state.operationRead = async () => Response.json({ message: "Operation unavailable" }, { status: 503 });
    await act(async () => streams[0]!.dispatchEvent(new MessageEvent("agent_event", { data: JSON.stringify(event(107, 2)) })));
    const retry = await screen.findByRole("button", { name: "Retry operation" });
    const eventReads = calls(eventsPath).length;
    const agentReads = calls(agentPath).length;
    state.operationRead = async () => Response.json(state.operation);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("runtime initialize")).toBeTruthy();
    expect(calls(eventsPath)).toHaveLength(eventReads);
    expect(calls(agentPath)).toHaveLength(agentReads);
    expect(screen.queryByText("completed", { exact: true })).toBeNull();
  });
});
