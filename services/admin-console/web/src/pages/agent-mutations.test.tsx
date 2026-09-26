import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentTemplate, DirectoryMember, LifecycleOperation } from "../lib/types";
import { AgentsPage } from "./agents";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  sessionStorage.clear();
});

const timestamp = "2026-09-07T00:00:00Z";
const agent: Agent = {
  agent_id: "agent-1", owner_user_id: "user-1", name: "Support Agent",
  desired_state: "enabled", lifecycle_state: "created", activation_state: "enabled", runtime_state: "available", aggregate_sequence: 2,
  agent_spec_revision: "spec-1", runtime: { runtime_revision: "runtime-1" }, executable_execution_revision: "execution-1",
  created_at: timestamp, updated_at: timestamp,
};
const template: AgentTemplate = {
  template_id: "template-1", name: "Support template", revision: 3,
  model_profile_id: "model-2", system_prompt: "", max_model_requests: 32,
  context_policy_version: "context-v1", enabled: true, skill_refs: [],
  runtime: { image_ref: `sha256:${"a".repeat(64)}`, resources: { memory_bytes: 1024, pids_limit: 128, tmpfs_bytes: 1024 } },
  created_at: timestamp, updated_at: timestamp,
};
const member: DirectoryMember = {
  user: { id: "user-1", system_role: "user", active: true, created_at: timestamp, updated_at: timestamp },
  membership: { id: "membership-1", user_id: "user-1", email: "owner@example.com", display_name: "Support owner", role: "member", source: "local", active: true, created_at: timestamp, updated_at: timestamp },
};

type Action = "disable" | "enable" | "rebuild" | "delete";
const labels: Record<Action, string> = { disable: "Disable", enable: "Enable", rebuild: "Rebuild", delete: "Delete Agent" };
const actions: Action[] = ["disable", "enable", "rebuild", "delete"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function operation(action: Action, state: "running" | "completed" = "completed"): LifecycleOperation {
  return {
    request_id: "request-1", agent_id: agent.agent_id, kind: action,
    phase: state === "completed" ? state : "drain", state,
    created_at: timestamp, updated_at: timestamp,
  };
}

function mockWorkflow(action: Action, command: () => Promise<Response>) {
  const initial = action === "enable" ? { ...agent, desired_state: "disabled", lifecycle_state: "created", activation_state: "disabled", runtime_state: "absent" } : agent;
  const state = { read: async () => Response.json(initial), eventsRead: async () => Response.json({ events: [], next_sequence: 0 }), operation: operation(action), operationRead: async (): Promise<Response> => Response.json(state.operation) };
  const streams: EventTarget[] = [];
  class TestEventSource extends EventTarget {
    onopen = null;
    onerror = null;
    constructor() { super(); streams.push(this); }
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (init.method === "GET" && url.pathname.endsWith("/network-policy")) return Response.json({ agent_id: url.pathname.split("/").at(-2), action: "deny_all", resource_version: 7, attachment: { state: "open", resource_version: 4 } });
    if (init.method === "POST") {
      expect(url.pathname).toBe(`/api/admin/agents/agent-1/${action}`);
      return command();
    }
    switch (url.pathname) {
      case "/api/admin/agents/agent-1": return state.read();
      case "/api/admin/agents/agent-2": return Response.json({ ...agent, agent_id: "agent-2", name: "Another Agent" });
      case "/api/admin/agents/agent-2/events":
      case "/api/admin/agents/agent-1/events": return state.eventsRead();
      case "/api/admin/templates": return Response.json({ items: [template] });
      case "/api/admin/directory": return Response.json({ users: [member], groups: [] });
      case "/api/admin/operations/request-1": return state.operationRead();
      default: throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
    }
  });
  vi.stubGlobal("fetch", fetch);
  window.location.hash = "agents/agent-1";
  return { state, fetch, streams };
}

async function start(action: Action) {
  const trigger = await screen.findByRole("button", { name: labels[action] });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  if (action !== "rebuild" && action !== "delete") return;
  const dialog = within(await screen.findByRole("dialog"));
  if (action === "rebuild") {
    fireEvent.change(dialog.getByLabelText("Template"), { target: { value: template.template_id } });
  }
  fireEvent.click(dialog.getByRole("button", { name: labels[action] }));
}

function postCalls(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.filter(([, init]) => init.method === "POST");
}

describe("Agent lifecycle command boundaries", () => {
  it("opens the independent Agent workspace without issuing a lifecycle command", async () => {
    const { fetch } = mockWorkflow("disable", async () => Response.json(operation("disable")));
    render(<AgentsPage agentID="agent-1" />);
    const link = await screen.findByRole("link", { name: "Open chat" });
    expect(link.getAttribute("href")).toBe("/workspace/agent-1/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(postCalls(fetch)).toHaveLength(0);
  });
  it("starts a new deletion after recovering a terminal failure whose admission response was lost", async () => {
    let sent = 0;
    const next = { ...operation("delete", "running"), request_id: "request-next" };
    const { state, fetch } = mockWorkflow("delete", async () => {
      if (++sent === 1) throw new TypeError("Connection lost");
      return Response.json(next, { status: 202 });
    });
    const firstPage = render(<AgentsPage agentID={agent.agent_id} />);
    await start("delete");
    await within(await screen.findByRole("dialog")).findByText("Connection lost");
    const firstKey = new Headers(postCalls(fetch)[0]![1].headers).get("Idempotency-Key");
    firstPage.unmount();
    state.read = async () => Response.json({ ...agent, desired_state: "deleted", lifecycle_state: "created", activation_state: "enabled", runtime_state: "unknown", aggregate_sequence: 3 });
    state.operation = { ...operation("delete"), state: "failed", error_code: "docker_denied", error_detail: "Deletion was rejected" };
    state.eventsRead = async () => Response.json({ events: [{ event_id: "failed", global_sequence: 8, aggregate_sequence: 3, schema_version: 1, agent_id: agent.agent_id, operation_request_id: "request-1", event_type: "agent_lifecycle_quarantined", occurred_at: timestamp }], next_sequence: 8 });
    const previous = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => input === "/api/admin/operations/request-next" ? Response.json(next) : previous(input, init));
    render(<AgentsPage agentID={agent.agent_id} />);
    await screen.findByText("Deletion was rejected");
    await start("delete");
    await screen.findByRole("heading", { name: "Current operation" });
    const posts = postCalls(fetch);
    expect(posts).toHaveLength(2);
    expect(firstKey).toBeTruthy();
    expect(new Headers(posts[1]![1].headers).get("Idempotency-Key")).not.toBe(firstKey);
  });
  it.each(["drain_timeout", "docker_denied"])("reopens a failed deletion with a new request identity (%s)", async (failure_code) => {
    const next = {...operation("delete", "running"), request_id:"request-next"};
    const {state, fetch} = mockWorkflow("delete", async () => Response.json(next, {status:202}));
    const failedAgent = {...agent, desired_state:"deleted", lifecycle_state: "created", activation_state: "enabled", runtime_state: "unknown", failure_code, failure_stage:"runtime_delete"};
    state.read = async () => Response.json(failedAgent);
    state.operation = {...operation("delete"), state:"failed", error_code:failure_code, error_detail:"Deletion could not complete"};
    state.eventsRead = async () => Response.json({events:[{event_id:"failure", global_sequence:8, aggregate_sequence:2, schema_version:1, agent_id:agent.agent_id, operation_request_id:"request-1", event_type:"agent_lifecycle_quarantined", occurred_at:timestamp}], next_sequence:8});
    const previous = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => input === "/api/admin/operations/request-next" ? Response.json(next) : previous(input, init));
    render(<AgentsPage agentID={agent.agent_id} />);
    await screen.findByText("Deletion could not complete");
    await start("delete");
    await screen.findByRole("heading", {name:"Current operation"});
    const posts = postCalls(fetch);
    expect(posts).toHaveLength(1);
    const key = new Headers(posts[0]![1].headers).get("Idempotency-Key");
    expect(key).toBeTruthy();
    expect(key).not.toBe("request-1");
  });
  it.each(["fresh", "lagging", "failed"].flatMap(outcome => [false, true].map(historyFirst => ({ outcome, historyFirst }))))("reconciles initial loss history ($outcome, historyFirst=$historyFirst) before trusting lifecycle actions", async ({ outcome, historyFirst }) => {
    const history = deferred<Response>();
    const initial = deferred<Response>();
    const { state, fetch } = mockWorkflow("rebuild", async () => Response.json({}));
    state.eventsRead = () => history.promise;
    if (historyFirst) state.read = () => initial.promise;
    render(<AgentsPage agentID={agent.agent_id} />);
    if (!historyFirst) await screen.findByRole("button", { name: "Disable" });
    state.read = async () => outcome === "fresh"
      ? Response.json({ ...agent, aggregate_sequence: 3, runtime_state: "absent", executable_execution_revision: undefined, failure_code: "runtime_missing", agent_spec_revision: "spec-old", last_successful_execution_revision: "execution-old" })
      : outcome === "failed" ? Response.json({ message: "Agent refresh failed" }, { status: 503 }) : Response.json(agent);
    await act(async () => history.resolve(Response.json({ events: [{ event_id: "lost", global_sequence: 111, aggregate_sequence: 3, schema_version: 1, agent_id: agent.agent_id, event_type: "agent_runtime_missing", occurred_at: timestamp }], next_sequence: 111 })));
    if (historyFirst) await act(async () => initial.resolve(Response.json(agent)));
    await screen.findByText("Runtime missing");
    if (outcome === "fresh") {
      expect(screen.getByRole("button", { name: "Rebuild" })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(false);
    }
    else {
      expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
      state.read = async () => Response.json({ ...agent, aggregate_sequence: 3 });
      fireEvent.click(screen.getByRole("button", { name: "Retry Agent state" }));
      await screen.findByRole("button", { name: "Disable" });
      expect(screen.queryByRole("alert")).toBeNull();
    }
    expect(postCalls(fetch)).toHaveLength(0);
  });

  it("retains the latest failed operation after history precedes an old active Agent snapshot", async () => {
    const initial = deferred<Response>();
    const { state, fetch } = mockWorkflow("rebuild", async () => Response.json({}));
    state.read = () => initial.promise;
    state.operation = { ...operation("rebuild"), state: "failed", error_code: "runtime_update_failed", error_detail: "Newest failure detail" };
    state.eventsRead = async () => Response.json({ events: [{ event_id: "new-failure", global_sequence: 112, aggregate_sequence: 4, schema_version: 1, agent_id: agent.agent_id, operation_request_id: "request-1", event_type: "agent_build_failed", occurred_at: timestamp }], next_sequence: 112 });
    const previousFetch = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => input === "/api/admin/operations/old-request"
      ? Response.json({ ...operation("rebuild"), request_id: "old-request" }) : previousFetch(input, init));
    render(<AgentsPage agentID={agent.agent_id} />);
    await waitFor(() => expect(fetch.mock.calls.some(([path]) => path === "/api/admin/operations/request-1")).toBe(true));
    state.read = async () => Response.json({ ...agent, aggregate_sequence: 4 });
    await act(async () => initial.resolve(Response.json({ ...agent, active_operation_request_id: "old-request" })));
    expect(await screen.findByText("Newest failure detail")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Last operation" })).toBeTruthy();
    expect(postCalls(fetch)).toHaveLength(0);
  });

  it("does not replace an accepted Rebuild with delayed historical operation evidence", async () => {
    const history = deferred<Response>();
    const { state, fetch } = mockWorkflow("rebuild", async () => Response.json(operation("rebuild", "running"), { status: 202 }));
    state.eventsRead = () => history.promise;
    state.operationRead = async () => Response.json(operation("rebuild", "running"));
    render(<AgentsPage agentID={agent.agent_id} />);
    await start("rebuild");
    await screen.findByRole("heading", { name: "Current operation" });
    const previousFetch = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => input === "/api/admin/operations/old-request"
      ? Response.json({ ...operation("rebuild"), request_id: "old-request" }) : previousFetch(input, init));
    await act(async () => history.resolve(Response.json({ events: [{ event_id: "old", global_sequence: 110, aggregate_sequence: 2, schema_version: 1, agent_id: agent.agent_id, operation_request_id: "old-request", event_type: "agent_ready", occurred_at: timestamp }], next_sequence: 110 })));
    expect(screen.getByRole("heading", { name: "Current operation" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Last operation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Lifecycle change in progress" })).toBeTruthy();
    expect(postCalls(fetch)).toHaveLength(1);
  });

  it.each(["active", "quarantined", "forbidden", "offline"])("rechecks %s authority inside an already open Rebuild dialog", async (outcome) => {
    const { state, fetch, streams } = mockWorkflow("rebuild", async () => Response.json(operation("rebuild"), { status: 202 }));
    render(<AgentsPage agentID={agent.agent_id} />);
    const trigger = await screen.findByRole("button", { name: "Rebuild" });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Template"), { target: { value: template.template_id } });
    state.read = async () => outcome === "forbidden" || outcome === "offline"
      ? Response.json({ message: "State not trustworthy" }, { status: outcome === "forbidden" ? 403 : 503 })
      : Response.json({ ...agent, aggregate_sequence: 3, ...(outcome === "active" ? { active_operation_request_id: "request-1" } : { lifecycle_state: "created", activation_state: "enabled", runtime_state: "unknown", failure_code: "lifecycle_invariant_failed", agent_spec_revision: "spec-old", last_successful_execution_revision: "execution-old" }) });
    state.operation = operation("rebuild", "running");
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    await act(async () => streams.at(-1)!.dispatchEvent(new MessageEvent("agent_event", { data: JSON.stringify({ event_id: "changed", global_sequence: 111, aggregate_sequence: 3, schema_version: 1, agent_id: agent.agent_id, event_type: "agent_runtime_missing", occurred_at: timestamp }) })));
    const confirm = dialog.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.submit(confirm.closest("form")!);
    expect(postCalls(fetch)).toHaveLength(0);
  });
  it.each(["runtime_deleted", "runtime_missing", "runtime_restarted"])("rebuilds a %s Agent explicitly and settles through authoritative events", async (failure_code) => {
    const lost = { ...agent, runtime_state: "unknown", executable_execution_revision: undefined, agent_spec_revision: "spec-old", last_successful_execution_revision: "execution-old", failure_code, failure_stage: "runtime_observation" };
    const { state, streams, fetch } = mockWorkflow("rebuild", async () => {
      state.operation = operation("rebuild", "running");
      state.read = async () => Response.json({ ...lost, aggregate_sequence: 3, active_operation_request_id: "request-1" });
      return Response.json(state.operation, { status: 202 });
    });
    state.read = async () => Response.json(lost);
    const page = render(<AgentsPage agentID={agent.agent_id} />);
    const reason = failure_code === "runtime_restarted" ? "The runtime restarted" : "The runtime is missing";
    expect((await screen.findByRole("alert")).textContent).toContain(reason);
    expect(screen.getByText(/Rebuild can restore the execution environment/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(postCalls(fetch)).toHaveLength(0);
    await start("rebuild");
    await screen.findByRole("heading", { name: "Current operation" });
    expect(postCalls(fetch)).toHaveLength(1);
    expect(JSON.parse(postCalls(fetch)[0]![1].body)).toEqual({ template_id: template.template_id, template_revision: template.revision });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    page.unmount();
    render(<AgentsPage agentID={agent.agent_id} />);
    await screen.findByRole("button", { name: "Lifecycle change in progress" });
    state.read = async () => Response.json({ ...agent, aggregate_sequence: 4, executable_execution_revision: "execution-new" });
    state.operation = operation("rebuild");
    await act(async () => streams.at(-1)!.dispatchEvent(new MessageEvent("agent_event", {
      data: JSON.stringify({ event_id: "rebuild-finished", global_sequence: 111, aggregate_sequence: 4, schema_version: 1, agent_id: agent.agent_id, operation_request_id: "request-1", event_type: "agent_rebuilt", occurred_at: timestamp }),
    })));
    await screen.findByRole("heading", { name: "Last operation" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Rebuild completed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
    expect(postCalls(fetch)).toHaveLength(1);
  });
  it("cleans up an unavailable Agent with no published Runtime through the existing Delete command", async () => {
    const { state, fetch } = mockWorkflow("delete", async () => {
      state.operation = operation("delete", "running");
      state.read = async () => Response.json({ ...agent, aggregate_sequence: 4, desired_state: "deleted", lifecycle_state: "created", activation_state: "enabled", runtime_state: "unknown", active_operation_request_id: "request-1" });
      return Response.json(state.operation, { status: 202 });
    });
    state.read = async () => Response.json({ ...agent, lifecycle_state: "not_created", activation_state: undefined, runtime_state: "unknown", agent_spec_revision: undefined, runtime: undefined, executable_execution_revision: undefined, failure_stage: "runtime_initialize", failure_code: "runtime_start_failed" });
    render(<AgentsPage agentID={agent.agent_id} />);
    await start("delete");
    await screen.findByRole("heading", { name: "Current operation" });
    expect(screen.getByRole("button", { name: "Lifecycle change in progress" }).getAttribute("disabled")).not.toBeNull();
    expect(postCalls(fetch)).toHaveLength(1);
    expect(JSON.parse(postCalls(fetch)[0]![1].body)).toEqual({});
    expect(screen.queryByText("completed", { exact: true })).toBeNull();
  });
  it("shows managed MCP servers from the frozen configuration and links its template revision", async () => {
    const { state } = mockWorkflow("rebuild", async () => Response.json({}));
    state.read = async () => Response.json({ ...agent, configuration: {
      template: { template_id: "template-1", revision: 1, name: "Frozen template" },
      model_profile: { model_profile_id: "model-1", revision_id: "model-rev-1", revision: 1, name: "Model", model: { model: "support", context_window: 8192, max_output_tokens: 1024 } },
      runtime: { ...template.runtime, mcp_servers: [{ id: "documents", command: "node" }] },
      max_model_requests: 32, context_policy_version: "context-v1",
    } });
    render(<AgentsPage agentID="agent-1" />);
    expect(await screen.findByRole("heading", { name: "Deployed MCP servers" })).toBeTruthy();
    expect(screen.getByText("documents")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Frozen template/ }).getAttribute("href")).toBe("#templates/template-1/revisions/1");
    expect(screen.queryByRole("button", { name: "Add MCP server" })).toBeNull();
  });
  it("does not carry a pending dialog or its late rejection into another Agent", async () => {
    const command = deferred<Response>();
    mockWorkflow("rebuild", () => command.promise);
    const page = render(<AgentsPage agentID={agent.agent_id} />);
    await start("rebuild");
    page.rerender(<AgentsPage agentID="agent-2" />);
    await screen.findByRole("heading", { name: "Another Agent" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => command.resolve(Response.json({ message: "Old Agent request rejected" }, { status: 409 })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(actions)("keeps an accepted %s separate from a failed Agent refresh and retries only the read", async (action) => {
    const command = deferred<Response>();
    const { state, fetch } = mockWorkflow(action, () => command.promise);
    render(<AgentsPage agentID={agent.agent_id} />);
    await start(action);
    state.read = async () => Response.json({ message: "Agent state unavailable" }, { status: 503 });
    state.operation = operation(action, "running");
    await act(async () => command.resolve(Response.json(operation(action, "running"), { status: 202 })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("status", { name: "" })).textContent).toMatch(/request accepted/i);
    expect(screen.getByRole("alert").textContent).toContain("Agent state unavailable");
    expect(screen.getByRole("heading", { name: "Current operation" })).toBeTruthy();
    expect(screen.getByText("running", { exact: true })).toBeTruthy();
    expect(screen.getByRole("heading", { name: agent.name })).toBeTruthy();
    for (const name of Object.values(labels)) expect(screen.queryByRole("button", { name })).toBeNull();

    const read = deferred<Response>();
    state.read = () => read.promise;
    const retry = screen.getByRole("button", { name: "Retry Agent state" }) as HTMLButtonElement;
    const beforeRetry = fetch.mock.calls.length;
    fireEvent.click(retry);
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(fetch.mock.calls.length).toBe(beforeRetry + 1);
    for (const name of Object.values(labels)) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(postCalls(fetch)).toHaveLength(1);
    const desired = action === "delete" ? "deleted" : action === "disable" ? "disabled" : "enabled";
    state.operation = operation(action);
    await act(async () => read.resolve(Response.json({
      ...agent, aggregate_sequence: 4, desired_state: desired,
      lifecycle_state: desired === "deleted" ? "deleted" : "created",
      activation_state: desired === "deleted" ? undefined : desired,
      runtime_state: desired === "enabled" ? "available" : "absent",
      executable_execution_revision: desired === "enabled" ? "execution-1" : undefined,
    })));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("completed", { exact: true })).toBeTruthy();
    expect(screen.getByRole("status", { name: "" }).textContent).toMatch(/request accepted/i);
    expect(window.location.hash).toBe("#agents/agent-1");
    expect(postCalls(fetch)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss success message" }));
    expect(screen.queryByRole("status", { name: "" })).toBeNull();
  });

  it.each(["completed", "failed"] as const)("does not downgrade %s operation evidence when its 202 response arrives late", async (terminal) => {
    const command = deferred<Response>();
    const { state, streams, fetch } = mockWorkflow("disable", () => command.promise);
    render(<AgentsPage agentID={agent.agent_id} />);
    await start("disable");
    state.read = async () => Response.json({ ...agent, aggregate_sequence: 4, desired_state: "disabled", activation_state: terminal === "completed" ? "disabled" : "enabled", runtime_state: terminal === "completed" ? "absent" : "unknown", executable_execution_revision: undefined });
    state.operation = { ...operation("disable"), state: terminal, error_code: terminal === "failed" ? "runtime_stop_failed" : undefined, error_detail: terminal === "failed" ? "Runtime did not stop" : undefined };
    await act(async () => streams.at(-1)!.dispatchEvent(new MessageEvent("agent_event", {
      data: JSON.stringify({ event_id: "terminal-event", global_sequence: 110, aggregate_sequence: 4, schema_version: 1, agent_id: agent.agent_id, operation_request_id: "request-1", event_type: "agent_disabled", occurred_at: timestamp }),
    })));
    expect(await screen.findByText(terminal, { exact: true })).toBeTruthy();
    const refresh = deferred<Response>();
    const settledRead = state.read;
    state.read = () => refresh.promise;
    await act(async () => command.resolve(Response.json(operation("disable", "running"), { status: 202 })));
    expect(screen.getByText(terminal, { exact: true })).toBeTruthy();
    expect(screen.queryByText("running", { exact: true })).toBeNull();
    await act(async () => refresh.resolve(await settledRead()));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Lifecycle change in progress" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Last operation" })).toBeTruthy();
    expect(screen.getByText(terminal, { exact: true })).toBeTruthy();
    if (terminal === "failed") expect(screen.getByText("runtime_stop_failed", { exact: true })).toBeTruthy();
    expect(screen.queryByText("running", { exact: true })).toBeNull();
    expect(postCalls(fetch)).toHaveLength(1);
  });

  it("does not invalidate an in-flight operation result when admission arrives and the Agent refresh fails", async () => {
    const command = deferred<Response>();
    const progress = deferred<Response>();
    const { state, streams, fetch } = mockWorkflow("disable", () => command.promise);
    render(<AgentsPage agentID={agent.agent_id} />);
    await start("disable");
    state.operationRead = async () => (await progress.promise).clone();
    state.read = async () => Response.json({ ...agent, aggregate_sequence: 4, desired_state: "disabled", lifecycle_state: "created", activation_state: "disabled", runtime_state: "absent" });
    await act(async () => streams.at(-1)!.dispatchEvent(new MessageEvent("agent_event", {
      data: JSON.stringify({ event_id: "terminal-event", global_sequence: 110, aggregate_sequence: 4, schema_version: 1, agent_id: agent.agent_id, operation_request_id: "request-1", event_type: "agent_disabled", occurred_at: timestamp }),
    })));
    expect(fetch.mock.calls.some(([url]) => url === "/api/admin/operations/request-1")).toBe(true);
    state.read = async () => Response.json({ message: "Agent state unavailable" }, { status: 503 });
    await act(async () => command.resolve(Response.json(operation("disable", "running"), { status: 202 })));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent state unavailable");
    await act(async () => progress.resolve(Response.json(operation("disable"))));
    expect(await screen.findByText("completed", { exact: true })).toBeTruthy();
    expect(screen.queryByText("running", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry Agent state" })).toBeTruthy();
    expect(postCalls(fetch)).toHaveLength(1);
  });

  it.each(actions)("hands an admitted %s to authoritative operation progress without resubmitting", async (action) => {
    const command = deferred<Response>();
    const { state, fetch, streams } = mockWorkflow(action, () => command.promise);
    render(<AgentsPage agentID={agent.agent_id} />);
    await start(action);
    state.read = async () => Response.json({
      ...agent, aggregate_sequence: 3, active_operation_request_id: "request-1",
    });
    state.operation = operation(action, "running");
    await act(async () => command.resolve(Response.json(operation(action, "running"), { status: 202 })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("status", { name: "" })).textContent).toMatch(/request accepted/i);
    expect(screen.getByRole("heading", { name: "Current operation" })).toBeTruthy();
    expect(screen.queryByText("completed", { exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Lifecycle change in progress" }).getAttribute("disabled")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(postCalls(fetch)).toHaveLength(1);
    const desired = action === "delete" ? "deleted" : action === "disable" ? "disabled" : "enabled";
    state.read = async () => Response.json({
      ...agent, aggregate_sequence: 4, desired_state: desired,
      lifecycle_state: desired === "deleted" ? "deleted" : "created",
      activation_state: desired === "deleted" ? undefined : desired,
      runtime_state: desired === "enabled" ? "available" : "absent",
      executable_execution_revision: desired === "enabled" ? "execution-1" : undefined,
    });
    state.operation = operation(action);
    await act(async () => streams.at(-1)!.dispatchEvent(new MessageEvent("agent_event", {
      data: JSON.stringify({
        event_id: "terminal-event", global_sequence: 110, aggregate_sequence: 4,
        schema_version: 1, agent_id: agent.agent_id, operation_request_id: "request-1",
        event_type: { disable: "agent_disabled", enable: "agent_enabled", delete: "agent_deleted", rebuild: "agent_rebuilt" }[action],
        occurred_at: timestamp,
      }),
    })));
    expect(await screen.findByRole("heading", { name: "Last operation" })).toBeTruthy();
    expect(screen.getAllByText("completed", { exact: true })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Current operation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lifecycle change in progress" })).toBeNull();
    expect(postCalls(fetch)).toHaveLength(1);
  });

  it.each([403, 404, 410])("preserves admission when the follow-up read returns terminal %s without offering retry", async (status) => {
    const command = deferred<Response>();
    const { state, fetch } = mockWorkflow("disable", () => command.promise);
    render(<AgentsPage agentID={agent.agent_id} />);
    await start("disable");
    state.read = async () => Response.json({ message: "Agent state no longer accessible" }, { status });
    await act(async () => command.resolve(Response.json(operation("disable"), { status: 202 })));
    expect((await screen.findByRole("status", { name: "" })).textContent).toMatch(/request accepted/i);
    expect(screen.getByRole("alert").textContent).toContain("Agent state no longer accessible");
    expect(screen.queryByRole("button", { name: "Retry Agent state" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(postCalls(fetch)).toHaveLength(1);
  });

  it.each(["rebuild", "delete"] as const)("retains a rejected %s inside its dialog and prevents dismissal/duplication before admission", async (action) => {
    const command = deferred<Response>();
    const { fetch } = mockWorkflow(action, () => command.promise);
    render(<AgentsPage agentID={agent.agent_id} />);
    await start(action);
    const element = screen.getByRole("dialog");
    const dialog = within(element);
    for (const name of [labels[action], "Cancel", "Close dialog"]) {
      expect((dialog.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(dialog.getByRole("button", { name }));
    }
    fireEvent.keyDown(element, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBe(element);
    expect(postCalls(fetch)).toHaveLength(1);
    await act(async () => command.resolve(Response.json({ message: "Lifecycle change not permitted" }, { status: 403 })));
    expect((await dialog.findByRole("alert")).textContent).toContain("Lifecycle change not permitted");
    expect(screen.queryByRole("status", { name: "" })).toBeNull();
    if (action === "rebuild") {
      expect((dialog.getByLabelText("Template") as HTMLSelectElement).value).toBe(template.template_id);
      expect(JSON.parse(postCalls(fetch)[0]![1].body)).toEqual({ template_id: template.template_id, template_revision: 3 });
    }
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: labels[action] }));
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
  });
});

describe("Agent creation admission", () => {
  it.each(["lost response", "503"])("retains one creation intent after %s and navigates only after acknowledgement", async (failure) => {
    const command = deferred<Response>();
    const state = {
      agent: { ...agent, lifecycle_state: "not_created", activation_state: undefined, runtime_state: "unknown", runtime: undefined, agent_spec_revision: undefined, executable_execution_revision: undefined, active_operation_request_id: "request-1" } as Agent,
      operation: { ...operation("rebuild", "running"), kind: "create", phase: "network_ensure" },
    };
    const streams: EventTarget[] = [];
    class TestEventSource extends EventTarget {
      onopen = null;
      onerror = null;
      close() {}
      constructor() { super(); streams.push(this); }
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const sent: Array<{ body: string; key: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input, "http://localhost");
      if (init.method === "GET" && url.pathname.endsWith("/network-policy")) return Response.json({ agent_id: url.pathname.split("/").at(-2), action: "deny_all", resource_version: 7, attachment: { state: "open", resource_version: 4 } });
      if (init.method === "POST") {
        expect(url.pathname).toBe("/api/admin/agents");
        sent.push({ body: String(init.body), key: new Headers(init.headers).get("Idempotency-Key") });
        if (sent.length === 1) {
          await command.promise;
          if (failure === "lost response") throw new TypeError("Response lost after admission");
          return Response.json({ message: "Admission response unavailable" }, { status: 503 });
        }
        return Response.json({ agent: state.agent, operation: state.operation }, { status: 202 });
      }
      switch (url.pathname) {
        case "/api/admin/agents": return Response.json({ items: [] });
        case "/api/admin/agents/agent-1": return Response.json(state.agent);
        case "/api/admin/agents/agent-1/events": return Response.json({ events: [], next_sequence: 0 });
        case "/api/admin/operations/request-1": return Response.json(state.operation);
        case "/api/admin/templates": return Response.json({ items: [template] });
        case "/api/admin/directory": return Response.json({ users: [member], groups: [] });
        default: throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
      }
    }));
    window.location.hash = "agents";
    const page = render(<AgentsPage />);
    await waitFor(() => expect((screen.getAllByRole("button", { name: "Create Agent" })[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getAllByRole("button", { name: "Create Agent" })[0]!);
    const element = await screen.findByRole("dialog");
    const dialog = within(element);
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Support Agent" } });
    fireEvent.change(dialog.getByLabelText("Owner"), { target: { value: member.user.id } });
    fireEvent.change(dialog.getByLabelText("Template"), { target: { value: template.template_id } });
    fireEvent.click(dialog.getByRole("button", { name: "Create Agent" }));
    for (const name of ["Create Agent", "Cancel", "Close dialog"]) {
      expect((dialog.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(dialog.getByRole("button", { name }));
    }
    fireEvent.keyDown(element, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBe(element);
    expect(sent).toHaveLength(1);
    await act(async () => command.resolve(new Response()));
    await dialog.findByRole("alert");
    expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe("Support Agent");
    expect((dialog.getByLabelText("Owner") as HTMLSelectElement).value).toBe(member.user.id);
    expect((dialog.getByLabelText("Template") as HTMLSelectElement).value).toBe(template.template_id);
    expect(window.location.hash).toBe("#agents");
    fireEvent.click(dialog.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.hash).toBe("#agents/agent-1");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]!.key).toBeTruthy();
    expect(JSON.parse(sent[0]!.body)).toEqual({
      owner_user_id: member.user.id, name: agent.name,
      template_id: template.template_id, template_revision: template.revision,
    });
    // Follow the acknowledged detail route; HTTP 202 still means provisioning.
    page.rerender(<AgentsPage agentID="agent-1" />);
    await screen.findByText("network ensure");
    expect(screen.getByRole("heading", { name: "Current operation" })).toBeTruthy();
    expect(screen.queryByText("completed", { exact: true })).toBeNull();
    await waitFor(() => expect(streams).toHaveLength(1));
    state.agent = { ...agent, aggregate_sequence: 3 };
    state.operation = { ...state.operation, state: "completed", phase: "completed" };
    await act(async () => streams[0]!.dispatchEvent(new MessageEvent("agent_event", {
      data: JSON.stringify({
        event_id: "ready-event", global_sequence: 109, aggregate_sequence: 3,
        schema_version: 1, agent_id: agent.agent_id, operation_request_id: "request-1",
        event_type: "agent_ready", occurred_at: timestamp,
      }),
    })));
    await screen.findByRole("heading", { name: "Last operation" });
    expect(screen.getAllByText("completed", { exact: true })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Lifecycle change in progress" })).toBeNull();
    expect(sent).toHaveLength(2);
  });
});
