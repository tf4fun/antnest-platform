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
  desired_state: "enabled", lifecycle_state: "available", aggregate_sequence: 2,
  created_at: timestamp, updated_at: timestamp,
};
const template: AgentTemplate = {
  template_id: "template-1", name: "Support template", revision: 3,
  model_profile_revision_id: "model-revision-2", system_prompt: "", max_model_requests: 32,
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
  const initial = action === "enable" ? { ...agent, desired_state: "disabled", lifecycle_state: "disabled" } : agent;
  const state = { read: async () => Response.json(initial), operation: operation(action) };
  class TestEventSource extends EventTarget {
    onopen = null;
    onerror = null;
    close() {}
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (init.method === "POST") {
      expect(url.pathname).toBe(`/api/admin/agents/agent-1/${action}`);
      return command();
    }
    switch (url.pathname) {
      case "/api/admin/agents/agent-1": return state.read();
      case "/api/admin/agents/agent-2": return Response.json({ ...agent, agent_id: "agent-2", name: "Another Agent" });
      case "/api/admin/agents/agent-2/events":
      case "/api/admin/agents/agent-1/events": return Response.json({ events: [], next_sequence: 0 });
      case "/api/admin/templates": return Response.json({ items: [template] });
      case "/api/admin/directory": return Response.json({ users: [member], groups: [] });
      case "/api/admin/operations/request-1": return Response.json(state.operation);
      default: throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
    }
  });
  vi.stubGlobal("fetch", fetch);
  window.location.hash = "agents/agent-1";
  return { state, fetch };
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
    await act(async () => command.resolve(Response.json(operation(action), { status: 202 })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("status")).textContent).toMatch(/request accepted/i);
    expect(screen.getByRole("alert").textContent).toContain("Agent state unavailable");
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
    await act(async () => read.resolve(Response.json({
      ...agent, aggregate_sequence: 4, desired_state: desired,
      lifecycle_state: desired === "enabled" ? "available" : desired,
    })));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/request accepted/i);
    expect(window.location.hash).toBe("#agents/agent-1");
    expect(postCalls(fetch)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss success message" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(actions)("hands an admitted %s to authoritative operation progress without resubmitting", async (action) => {
    const command = deferred<Response>();
    const { state, fetch } = mockWorkflow(action, () => command.promise);
    render(<AgentsPage agentID={agent.agent_id} />);
    await start(action);
    state.read = async () => Response.json({
      ...agent, aggregate_sequence: 3, active_operation_request_id: "request-1",
    });
    state.operation = operation(action, "running");
    await act(async () => command.resolve(Response.json(operation(action, "running"), { status: 202 })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("status")).textContent).toMatch(/request accepted/i);
    expect(screen.getByRole("heading", { name: "Current operation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lifecycle change in progress" }).getAttribute("disabled")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(postCalls(fetch)).toHaveLength(1);
  });

  it.each([403, 404, 410])("preserves admission when the follow-up read returns terminal %s without offering retry", async (status) => {
    const command = deferred<Response>();
    const { state, fetch } = mockWorkflow("disable", () => command.promise);
    render(<AgentsPage agentID={agent.agent_id} />);
    await start("disable");
    state.read = async () => Response.json({ message: "Agent state no longer accessible" }, { status });
    await act(async () => command.resolve(Response.json(operation("disable"), { status: 202 })));
    expect((await screen.findByRole("status")).textContent).toMatch(/request accepted/i);
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
    expect(screen.queryByRole("status")).toBeNull();
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
    const sent: Array<{ body: string; key: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input, "http://localhost");
      if (init.method === "POST") {
        expect(url.pathname).toBe("/api/admin/agents");
        sent.push({ body: String(init.body), key: new Headers(init.headers).get("Idempotency-Key") });
        if (sent.length === 1) {
          await command.promise;
          if (failure === "lost response") throw new TypeError("Response lost after admission");
          return Response.json({ message: "Admission response unavailable" }, { status: 503 });
        }
        return Response.json({ agent: { ...agent, lifecycle_state: "provisioning" }, operation: { ...operation("rebuild", "running"), kind: "create", phase: "network_ensure" } }, { status: 202 });
      }
      switch (url.pathname) {
        case "/api/admin/agents": return Response.json({ items: [] });
        case "/api/admin/templates": return Response.json({ items: [template] });
        case "/api/admin/directory": return Response.json({ users: [member], groups: [] });
        default: throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
      }
    }));
    window.location.hash = "agents";
    render(<AgentsPage />);
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
  });
});
