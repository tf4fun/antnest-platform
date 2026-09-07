import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentEvent, LifecycleOperation } from "../lib/types";
import { AgentsPage } from "./agents";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  sessionStorage.clear();
});

const timestamp = "2026-09-07T00:00:00Z";
const baseAgent: Agent = {
  agent_id: "agent-1", owner_user_id: "user-1", name: "Support Agent",
  desired_state: "enabled", lifecycle_state: "available", aggregate_sequence: 2,
  created_at: timestamp, updated_at: timestamp,
};
const baseOperation: LifecycleOperation = {
  request_id: "operation-1", agent_id: baseAgent.agent_id,
  kind: "rebuild", phase: "completed", state: "completed",
  created_at: timestamp, updated_at: timestamp,
};

function eventFor(operation: LifecycleOperation, sequence = 2): AgentEvent {
  const types: Record<string, string> = {
    "rebuild:completed": "agent_rebuilt",
    "rebuild:failed": "agent_build_failed",
    "delete:running": "agent_delete_requested",
    "delete:completed": "agent_deleted",
  };
  return {
    event_id: `event-${sequence}`, global_sequence: sequence,
    aggregate_sequence: sequence, schema_version: 1, agent_id: baseAgent.agent_id,
    event_type: types[`${operation.kind}:${operation.state}`]!,
    operation_request_id: operation.request_id, occurred_at: timestamp,
  };
}

function mockDetail(initialAgent: Agent, initialOperation: LifecycleOperation) {
  const state = { agent: initialAgent, operation: initialOperation };
  const streams: TestEventSource[] = [];
  class TestEventSource extends EventTarget {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(_url: string) { super(); streams.push(this); }
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    const url = new URL(input, "http://localhost");
    switch (url.pathname) {
      case "/api/admin/agents/agent-1": return Response.json(state.agent);
      case "/api/admin/agents/agent-1/events":
        return Response.json({ events: [eventFor(state.operation)], next_sequence: 2 });
      case "/api/admin/operations/operation-1": return Response.json(state.operation);
      case "/api/admin/templates": return Response.json({ items: [] });
      case "/api/admin/directory": return Response.json({ users: [], groups: [] });
      default: throw new Error(`Unexpected request: ${url.pathname}`);
    }
  });
  vi.stubGlobal("fetch", fetch);
  window.location.hash = `agents/${baseAgent.agent_id}`;
  return { state, streams, fetch };
}

describe("Agent operation presentation", () => {
  it("keeps a retained Agent detail open when replay reads its completed deletion", async () => {
    mockDetail(
      { ...baseAgent, desired_state: "deleted", lifecycle_state: "deleted" },
      { ...baseOperation, kind: "delete" },
    );
    render(<AgentsPage agentID={baseAgent.agent_id} />);
    await screen.findByText("delete", { selector: "span" });
    expect(window.location.hash).toBe("#agents/agent-1");
    expect(screen.getByRole("heading", { name: "Last operation" })).toBeTruthy();
    expect(screen.getByText("retained for audit")).toBeTruthy();
    for (const name of ["Delete Agent", "Rebuild", "Disable", "Enable"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Back to Agents" }));
    expect(window.location.hash).toBe("#agents");
  });

  it("presents an idle Agent's completed operation once as its last operation", async () => {
    mockDetail(baseAgent, baseOperation);
    render(<AgentsPage agentID={baseAgent.agent_id} />);
    await screen.findByRole("heading", { name: "Last operation" });
    expect(screen.queryByRole("heading", { name: "Current operation" })).toBeNull();
    expect(screen.getAllByText("completed", { exact: true })).toHaveLength(1);
  });

  it("retains the distinct phase and diagnostic detail of a failed operation", async () => {
    mockDetail(
      { ...baseAgent, lifecycle_state: "failed" },
      { ...baseOperation, state: "failed", phase: "runtime_update", error_detail: "Runtime image unavailable" },
    );
    render(<AgentsPage agentID={baseAgent.agent_id} />);
    await screen.findByRole("heading", { name: "Last operation" });
    expect(screen.getByText("runtime update")).toBeTruthy();
    expect(screen.getByText("Runtime image unavailable")).toBeTruthy();
  });

  it("transitions a live deletion to read-only retained detail without redirecting", async () => {
    const { state, streams } = mockDetail(
      { ...baseAgent, desired_state: "deleted", lifecycle_state: "deleting", active_operation_request_id: baseOperation.request_id },
      { ...baseOperation, kind: "delete", state: "running", phase: "runtime_delete" },
    );
    render(<AgentsPage agentID={baseAgent.agent_id} />);
    await screen.findByText("runtime delete");
    expect(screen.getByRole("heading", { name: "Current operation" })).toBeTruthy();
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    state.agent = { ...baseAgent, aggregate_sequence: 3, desired_state: "deleted", lifecycle_state: "deleted" };
    state.operation = { ...baseOperation, kind: "delete" };
    act(() => {
      streams[streams.length - 1]!.dispatchEvent(new MessageEvent("agent_event", {
        data: JSON.stringify(eventFor(state.operation, 3)),
      }));
    });
    await screen.findByText("completed", { exact: true });
    expect(window.location.hash).toBe("#agents/agent-1");
    expect(screen.getByRole("heading", { name: "Last operation" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Current operation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Agent" })).toBeNull();
    cleanup();
    for (const stream of streams) expect(stream.close).toHaveBeenCalled();
  });
});
