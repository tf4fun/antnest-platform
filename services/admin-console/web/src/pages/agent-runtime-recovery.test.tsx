import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSessionRequests } from "../lib/api";
import type { LifecycleOperation } from "../lib/types";
import { AgentsPage } from "./agents";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  sessionStorage.clear();
});

const timestamp = "2026-09-07T00:00:00Z";
const requestID = "rebuild_original";
const operationPath = `/api/admin/operations/${requestID}`;
const rebuildPath = "/api/admin/agents/agent-1/rebuild";
const recovery = {
  barrier_id: "barrier-\u0000-original-🧪",
  reason: "runtime_barrier_required",
  runtime_revision: "runtime-1",
  policy_revision: 0,
  mode: "manual",
  cooldown_ms: 300000,
  rebuild_request_id: requestID,
  notification_id: "notification_original",
  cooldown_until: null,
};
const runtime = {
  image_ref: `sha256:${"a".repeat(64)}`,
  resources: { memory_bytes: 1024, pids_limit: 128, tmpfs_bytes: 1024 },
};
// Keep the new wire as an ordinary object: the first red must be a missing
// rendered recovery action, rather than a reference to a production type/API.
const recoverableAgent = {
  agent_id: "agent-1", owner_user_id: "user-1", name: "Support Agent",
  desired_state: "enabled", lifecycle_state: "created", activation_state: "enabled",
  runtime_state: "available", aggregate_sequence: 2,
  agent_spec_revision: "spec-1", runtime: { runtime_revision: "runtime-1" },
  executable_execution_revision: "execution-1", runtime_recovery: recovery,
  configuration: {
    template: { template_id: "template-1", revision: 1, name: "Configured template" },
    model_profile: { model_profile_id: "model-1", revision_id: "model-rev-1", revision: 1,
      name: "Configured model", model: { model: "support", context_window: 8192, max_output_tokens: 1024 } },
    max_model_requests: 32, context_policy_version: "context-v1", runtime,
  },
  created_at: timestamp, updated_at: timestamp,
};
const latestTemplate = {
  template_id: "template-1", name: "Latest template", revision: 3,
  model_profile_id: "model-1", system_prompt: "", max_model_requests: 32,
  context_policy_version: "context-v1", enabled: true, skill_refs: [], runtime,
  created_at: timestamp, updated_at: timestamp,
};
const member = {
  user: { id: "user-1", system_role: "user", active: true, created_at: timestamp, updated_at: timestamp },
  membership: { id: "membership-1", user_id: "user-1", email: "owner@example.test",
    display_name: "Support owner", role: "member", source: "local", active: true,
    created_at: timestamp, updated_at: timestamp },
};
const originalInput = {
  template_id: "template-1", template_revision: 1,
  recovery: { barrier_id: recovery.barrier_id, expected_runtime_revision: recovery.runtime_revision },
};

function operation(state = "running"): LifecycleOperation {
  return {
    request_id: requestID, agent_id: "agent-1", kind: "rebuild", state,
    phase: state === "running" ? "drain" : state,
    created_at: timestamp, updated_at: timestamp,
  };
}

function missingOperation(): Response {
  return Response.json({ code: "operation_not_found", message: "Recovery operation was not found" }, { status: 404 });
}

type CapturedRequest = {
  path: string;
  method: string;
  body: string | undefined;
  headers: Headers;
  signal: AbortSignal | null | undefined;
};
type WorkflowState = {
  read: () => Promise<Response>;
  eventsRead: () => Promise<Response>;
  operationRead: () => Promise<Response>;
  command: (request: CapturedRequest) => Promise<Response>;
  savedOperation: LifecycleOperation | null;
};

function mockWorkflow() {
  const requests: CapturedRequest[] = [];
  const pending = new Set<Promise<Response>>();
  const releases: Array<() => void> = [];
  const unexpected: string[] = [];
  const streams: Array<{ closed: boolean; close(): void }> = [];
  class TestEventSource extends EventTarget {
    onopen = null;
    onerror = null;
    closed = false;
    constructor() { super(); streams.push(this); }
    close() { this.closed = true; }
  }
  vi.stubGlobal("EventSource", TestEventSource);
  const state: WorkflowState = {
    read: async () => Response.json(recoverableAgent),
    eventsRead: async () => Response.json({ events: [], next_sequence: 0 }),
    operationRead: async () => state.savedOperation === null ? missingOperation() : Response.json(state.savedOperation),
    command: async () => {
      state.savedOperation = operation();
      return Response.json(state.savedOperation, { status: 202 });
    },
    savedOperation: null,
  };
  const respond = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const request: CapturedRequest = {
      path: url.pathname, method: init.method ?? "GET",
      body: init.body === undefined ? undefined : String(init.body),
      headers: new Headers(init.headers), signal: init.signal,
    };
    requests.push(request);
    if (request.method === "GET" && url.pathname.endsWith("/network-policy"))
      return Response.json({ agent_id: url.pathname.split("/").at(-2), action: "deny_all", resource_version: 7,
        attachment: { state: "open", resource_version: 4 } });
    if (request.method === "POST" && url.pathname === rebuildPath) return state.command(request);
    if (request.method === "GET") {
      switch (url.pathname) {
        case "/api/admin/agents/agent-1": return state.read();
        case "/api/admin/agents/agent-2": {
          const { runtime_recovery: _recovery, ...other } = recoverableAgent;
          void _recovery;
          return Response.json({ ...other, agent_id: "agent-2", name: "Another Agent" });
        }
        case "/api/admin/agents/agent-1/events":
        case "/api/admin/agents/agent-2/events": return state.eventsRead();
        case "/api/admin/templates": return Response.json({ items: [latestTemplate] });
        case "/api/admin/directory": return Response.json({ users: [member], groups: [] });
        case operationPath: return state.operationRead();
        case `/api/admin/agent-skill-preparations/${requestID}`:
          return Response.json({ code: "not_found", message: "No Skill preparation" }, { status: 404 });
      }
    }
    unexpected.push(`${request.method} ${url.pathname}`);
    throw new Error(`Unexpected recovery fixture request: ${request.method} ${url.pathname}`);
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const running = respond(input, init);
    pending.add(running);
    void running.then(() => pending.delete(running), () => pending.delete(running));
    return running;
  }));
  window.location.hash = "agents/agent-1";
  const join = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  return {
    state, requests, streams,
    posts: () => requests.filter(request => request.method === "POST"),
    queries: () => requests.filter(request => request.method === "GET" && request.path === operationPath),
    hold() {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>(done => { resolve = done; });
      releases.push(() => resolve(missingOperation()));
      return { promise, resolve };
    },
    join,
    async close(page: ReturnType<typeof render> | undefined) {
      page?.unmount();
      await act(async () => {
        for (const release of releases) release();
        await join();
      });
      const closedByOwner = streams.every(stream => stream.closed);
      for (const stream of streams) stream.close();
      expect(pending.size).toBe(0);
      expect(closedByOwner).toBe(true);
      expect(unexpected).toEqual([]);
    },
  };
}

type WorkflowFixture = ReturnType<typeof mockWorkflow>;

async function withPage(exercise: (fixture: WorkflowFixture, page: ReturnType<typeof render>) => Promise<void>) {
  const fixture = mockWorkflow();
  let page: ReturnType<typeof render> | undefined;
  try {
    page = render(<AgentsPage agentID="agent-1" />);
    await exercise(fixture, page);
  } finally {
    await fixture.close(page);
  }
}

async function openRecovery() {
  expect((await screen.findAllByText("Runtime recovery required", { exact: true })).length).toBeGreaterThan(0);
  const trigger = await screen.findByRole("button", { name: "Recover Runtime" });
  await waitFor(() => expect(trigger).toHaveProperty("disabled", false));
  fireEvent.click(trigger);
  return within(await screen.findByRole("dialog", { name: "Recover Runtime" }));
}

async function confirmRecovery() {
  const dialog = await openRecovery();
  const confirm = dialog.getByRole("button", { name: "Confirm recovery" });
  fireEvent.click(confirm);
  return confirm;
}

describe("Agent Runtime barrier recovery", () => {
  it("queries before a single held recovery POST and preserves the configured Template and opaque barrier", async () => {
    await withPage(async fixture => {
      const held = fixture.hold();
      fixture.state.command = async () => {
        fixture.state.savedOperation = operation();
        return held.promise;
      };
      const dialog = await openRecovery();
      expect(fixture.posts()).toHaveLength(0);
      const confirm = dialog.getByRole("button", { name: "Confirm recovery" });
      await act(async () => { fireEvent.click(confirm); fireEvent.click(confirm); });
      await waitFor(() => expect(fixture.posts()).toHaveLength(1));
      expect(confirm).toHaveProperty("disabled", true);
      fireEvent.click(confirm);
      expect(fixture.posts()).toHaveLength(1);
      expect(fixture.queries()).toHaveLength(1);
      const posted = fixture.posts()[0]!;
      expect(fixture.requests.indexOf(fixture.queries()[0]!)).toBeLessThan(fixture.requests.indexOf(posted));
      expect(posted.path).toBe(rebuildPath);
      expect(JSON.parse(posted.body!)).toEqual(originalInput);
      expect(posted.headers.get("Idempotency-Key")).toBe(requestID);
      expect(posted.headers.get("X-Antnest-CSRF-Token")).toBe("synthetic-test-session");
      await act(async () => { held.resolve(Response.json(operation(), { status: 202 })); await fixture.join(); });
      expect((await screen.findAllByText("running", { exact: true })).length).toBeGreaterThan(0);
      expect(fixture.posts()).toHaveLength(1);
    });
  });

  it.each(["running", "completed", "failed"])("adopts an existing %s recovery operation without any POST", async state => {
    await withPage(async fixture => {
      fixture.state.savedOperation = operation(state);
      await confirmRecovery();
      expect((await screen.findAllByText(state, { exact: true })).length).toBeGreaterThan(0);
      expect(fixture.queries().length).toBeGreaterThan(0);
      expect(fixture.posts()).toHaveLength(0);
    });
  });

  it.each(["query unavailable", "wrong request", "wrong Agent", "wrong kind",
    "200 null", "200 false", "200 zero", "200 empty string", "204 empty body"])("does not POST after %s", async failure => {
    await withPage(async fixture => {
      fixture.state.operationRead = async () => {
        if (failure === "query unavailable")
          return Response.json({ code: "dependency_unavailable", message: "Recovery query unavailable" }, { status: 503 });
        if (failure === "200 null") return Response.json(null);
        if (failure === "200 false") return Response.json(false);
        if (failure === "200 zero") return Response.json(0);
        if (failure === "200 empty string") return Response.json("");
        if (failure === "204 empty body") return new Response(null, { status: 204 });
        return Response.json({ ...operation(),
          ...(failure === "wrong request" ? { request_id: "rebuild_other" } : {}),
          ...(failure === "wrong Agent" ? { agent_id: "agent-2" } : {}),
          ...(failure === "wrong kind" ? { kind: "delete" } : {}),
        });
      };
      await confirmRecovery();
      expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
      expect(fixture.queries()).toHaveLength(1);
      expect(fixture.posts()).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Retry same recovery" })).toBeNull();
    });
  });

  it("checks the original operation after a lost response and never automatically resubmits", async () => {
    await withPage(async fixture => {
      fixture.state.command = async () => {
        fixture.state.savedOperation = operation();
        throw new TypeError("Recovery response lost");
      };
      await confirmRecovery();
      const check = await screen.findByRole("button", { name: "Check recovery request" });
      expect(fixture.posts()).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Retry same recovery" })).toBeNull();
      const readsBeforeCheck = fixture.queries().length;
      fireEvent.click(check);
      expect((await screen.findAllByText("running", { exact: true })).length).toBeGreaterThan(0);
      expect(fixture.queries().length).toBeGreaterThan(readsBeforeCheck);
      expect(fixture.posts()).toHaveLength(1);
    });
  });

  it("requires a read-only missing-operation check before an explicit retry of the same body and ID", async () => {
    await withPage(async fixture => {
      let commands = 0;
      fixture.state.command = async () => {
        if (++commands === 1) throw new TypeError("Recovery response lost");
        fixture.state.savedOperation = operation();
        return Response.json(fixture.state.savedOperation, { status: 202 });
      };
      await confirmRecovery();
      const check = await screen.findByRole("button", { name: "Check recovery request" });
      expect(fixture.posts()).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Retry same recovery" })).toBeNull();
      const readsBeforeCheck = fixture.queries().length;
      fireEvent.click(check);
      const retry = await screen.findByRole("button", { name: "Retry same recovery" });
      expect(fixture.queries().length).toBeGreaterThan(readsBeforeCheck);
      expect(fixture.posts()).toHaveLength(1);
      fireEvent.click(retry);
      await waitFor(() => expect(fixture.posts()).toHaveLength(2));
      expect(JSON.parse(fixture.posts()[0]!.body!)).toEqual(originalInput);
      expect(fixture.posts()[1]!.body).toBe(fixture.posts()[0]!.body);
      expect(fixture.posts().map(request => request.headers.get("Idempotency-Key"))).toEqual([requestID, requestID]);
      expect((await screen.findAllByText("running", { exact: true })).length).toBeGreaterThan(0);
    });
  });

  it("retains a recovery conflict without falling back to an ordinary Rebuild", async () => {
    await withPage(async fixture => {
      fixture.state.command = async () => Response.json({ code: "lifecycle_conflict", message: "The recovery binding changed" }, { status: 409 });
      await confirmRecovery();
      expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
      expect(fixture.posts()).toHaveLength(1);
      expect(JSON.parse(fixture.posts()[0]!.body!)).toEqual(originalInput);
      expect(fixture.posts()[0]!.headers.get("Idempotency-Key")).toBe(requestID);
      expect(screen.queryByRole("button", { name: "Retry same recovery" })).toBeNull();
    });
  });

  it.each([
    { invalidation: "Agent switch", result: "missing" },
    { invalidation: "Agent switch", result: "receipt" },
    { invalidation: "session reset", result: "missing" },
    { invalidation: "session reset", result: "receipt" },
  ])("does not dispatch or apply a held $result query after $invalidation", async ({ invalidation, result }) => {
    await withPage(async (fixture, page) => {
      const held = fixture.hold();
      fixture.state.operationRead = () => held.promise;
      await confirmRecovery();
      await waitFor(() => expect(fixture.queries()).toHaveLength(1));
      const query = fixture.queries()[0]!;
      if (invalidation === "Agent switch") {
        page.rerender(<AgentsPage agentID="agent-2" />);
        await screen.findByRole("heading", { name: "Another Agent" });
      } else {
        act(() => resetSessionRequests({ organization_id: "org-2", user_id: "admin-2", membership_id: "membership-2" }));
        expect(query.signal?.aborted).toBe(true);
      }
      await act(async () => {
        held.resolve(result === "missing" ? missingOperation() : Response.json(operation()));
        await fixture.join();
      });
      expect(fixture.posts()).toHaveLength(0);
      expect(screen.queryByRole("heading", { name: "Current operation" })).toBeNull();
      expect(screen.queryByText("running", { exact: true })).toBeNull();
      if (invalidation === "Agent switch") {
        expect(screen.queryByRole("dialog", { name: "Recover Runtime" })).toBeNull();
        expect(screen.getByRole("heading", { name: "Another Agent" })).toBeTruthy();
      }
    });
  });
});

describe("Runtime recovery shares the Agent lifecycle mutation boundary", () => {
  it.each(["query", "POST"] as const)("replaces ordinary lifecycle controls with a disabled progress indicator while the recovery %s is held", async stage => {
    await withPage(async fixture => {
      const disable = await screen.findByRole("button", { name: "Disable" });
      const rebuild = await screen.findByRole("button", { name: "Rebuild" });
      await waitFor(() => {
        expect(disable).toHaveProperty("disabled", false);
        expect(rebuild).toHaveProperty("disabled", false);
      });
      const held = fixture.hold();
      if (stage === "query") fixture.state.operationRead = () => held.promise;
      else fixture.state.command = async () => {
        fixture.state.savedOperation = operation();
        return held.promise;
      };
      await confirmRecovery();
      if (stage === "query") await waitFor(() => expect(fixture.queries()).toHaveLength(1));
      else await waitFor(() => expect(fixture.posts()).toHaveLength(1));
      expect(!disable.isConnected || (disable as HTMLButtonElement).disabled).toBe(true);
      expect(!rebuild.isConnected || (rebuild as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("Lifecycle change in progress").closest("button")).toHaveProperty("disabled", true);
      expect(fixture.requests.filter(request => request.method === "POST" && request.path !== rebuildPath)).toEqual([]);
      if (stage === "POST") {
        expect(JSON.parse(fixture.posts()[0]!.body!)).toEqual(originalInput);
        expect(fixture.posts()[0]!.headers.get("Idempotency-Key")).toBe(requestID);
      }
      // withPage's finally unmounts the owner, releases this uncooperative
      // dependency and joins its actual Promise before checking owned streams.
    });
  });

  it("excludes an ordinary command synchronously before the recovery query causes a render", async () => {
    await withPage(async fixture => {
      const disable = await screen.findByRole("button", { name: "Disable" });
      const held = fixture.hold();
      fixture.state.operationRead = () => held.promise;
      const dialog = await openRecovery();
      const confirm = dialog.getByRole("button", { name: "Confirm recovery" });
      await act(async () => {
        fireEvent.click(confirm);
        expect(disable.isConnected).toBe(true);
        fireEvent.click(disable);
      });
      expect(fixture.queries()).toHaveLength(1);
      expect(fixture.posts()).toHaveLength(0);
      expect(fixture.requests.filter(request => request.method === "POST")).toEqual([]);
    });
  });
});

describe("Runtime recovery query availability", () => {
  it("permits an explicit same-request retry only after a failed initial query is followed by a read-only missing receipt", async () => {
    await withPage(async fixture => {
      let queries = 0;
      fixture.state.operationRead = async () => {
        if (++queries === 1)
          return Response.json({ code: "dependency_unavailable", message: "Recovery query unavailable" }, { status: 503 });
        return fixture.state.savedOperation === null ? missingOperation() : Response.json(fixture.state.savedOperation);
      };
      await confirmRecovery();
      const check = await screen.findByRole("button", { name: "Check recovery request" });
      expect(fixture.queries()).toHaveLength(1);
      expect(fixture.posts()).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Retry same recovery" })).toBeNull();

      fireEvent.click(check);
      const retry = await screen.findByRole("button", { name: "Retry same recovery" });
      expect(fixture.queries()).toHaveLength(2);
      expect(fixture.posts()).toHaveLength(0);

      fireEvent.click(retry);
      await waitFor(() => expect(fixture.posts()).toHaveLength(1));
      expect(JSON.parse(fixture.posts()[0]!.body!)).toEqual(originalInput);
      expect(fixture.posts()[0]!.headers.get("Idempotency-Key")).toBe(requestID);
      expect((await screen.findAllByText("running", { exact: true })).length).toBeGreaterThan(0);
      expect(fixture.posts()).toHaveLength(1);
    });
  });
});
