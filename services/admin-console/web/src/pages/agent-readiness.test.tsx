import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionRequests } from "../lib/api";
import type { Agent, AgentEvent, LifecycleOperation } from "../lib/types";
import { testSession } from "../test/session-fixture";
import { AgentsPage } from "./agents";

declare const jsdom: { window: Window };

type Readiness = "preparing" | "ready" | "unavailable";
type CurrentAgent = Agent & { readiness?: Readiness };
const timestamp = "2026-10-23T00:00:00Z";
const networkScope = JSON.stringify(["org-1", "admin-1"]);
const preparingMessage = "Agent is preparing. Readiness refreshes automatically.";
const unknownMessage = "Agent readiness is unknown.";
const fixtures: Array<{ close(): Promise<void>; assertReadOnly(): void }> = [];

beforeEach(() => {
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
});

afterEach(async () => {
  try {
    for (const fixture of fixtures) await fixture.close();
    for (const fixture of fixtures) fixture.assertReadOnly();
  } finally {
    fixtures.length = 0;
    cleanup();
    vi.useRealTimers();
    window.location.hash = "";
    sessionStorage.clear();
    window.localStorage.clear();
  }
});

function agentSnapshot(agentID = "agent-1", readiness?: Readiness): CurrentAgent {
  return {
    agent_id: agentID,
    owner_user_id: "user-1",
    name: agentID === "agent-1" ? "Readiness Agent" : "Other Agent",
    desired_state: "enabled",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
    agent_spec_revision: "spec-1",
    executable_execution_revision: "execution-1",
    runtime: { runtime_revision: "runtime-1" },
    aggregate_sequence: 7,
    created_at: timestamp,
    updated_at: timestamp,
    ...(readiness === undefined ? {} : { readiness }),
  };
}

function operation(agentID: string): LifecycleOperation {
  return {
    request_id: "create-" + agentID,
    agent_id: agentID,
    kind: "create",
    state: "completed",
    phase: "completed",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function event(agentID: string, sequence: number, eventType: string, schemaVersion = 1): AgentEvent {
  return {
    event_id: `${agentID}-event-${sequence}`,
    global_sequence: sequence,
    aggregate_sequence: 7,
    schema_version: schemaVersion,
    agent_id: agentID,
    event_type: eventType,
    operation_request_id: operation(agentID).request_id,
    occurred_at: timestamp,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function readinessFixture(initialReadiness?: Readiness, holdInitial = false) {
  const agents = new Map<string, CurrentAgent>([
    ["agent-1", agentSnapshot("agent-1", initialReadiness)],
    ["agent-2", agentSnapshot("agent-2")],
  ]);
  const plans = new Map<string, Array<(signal?: AbortSignal) => Promise<Response>>>();
  const requests: Array<{ path: string; method: string }> = [];
  const unexpected: string[] = [];
  const agentReads: Array<{ agentID: string; signal?: AbortSignal; settled: boolean; promise: Promise<Response> }> = [];
  const pending = new Set<Promise<Response>>();
  const held: Array<{ promise: Promise<Response>; release(response?: Response): void }> = [];
  const streams: TestEventSource[] = [];
  let sequence = 101;
  let closing: Promise<void> | undefined;

  class TestEventSource extends EventTarget {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(readonly url: string) {
      super();
      streams.push(this);
    }
  }

  const enqueue = (agentID: string, read: (signal?: AbortSignal) => Promise<Response>) => {
    const queue = plans.get(agentID) ?? [];
    queue.push(read);
    plans.set(agentID, queue);
  };
  const holdNext = (agentID = "agent-1") => {
    const gate = deferred<Response>();
    const fallback = structuredClone(agents.get(agentID)!);
    const read = {
      promise: gate.promise,
      signal: undefined as AbortSignal | undefined,
      entered: false,
      released: false,
      release(response = Response.json(fallback)) {
        if (read.released) return;
        read.released = true;
        gate.resolve(response);
      },
    };
    held.push(read);
    enqueue(agentID, (signal) => {
      read.entered = true;
      read.signal = signal;
      // An abort is observed without pretending that the actual fetch settled.
      return read.promise;
    });
    return read;
  };

  vi.stubGlobal("EventSource", TestEventSource);
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost").pathname;
    const method = init.method ?? "GET";
    requests.push({ path, method });
    const run = async () => {
      if (method !== "GET") {
        unexpected.push("mutation " + path);
        return Response.json({ code: "unexpected_request" }, { status: 503 });
      }
      const match = path.match(/^\/api\/admin\/agents\/([^/]+)$/);
      if (match) {
        const agentID = decodeURIComponent(match[1]!);
        const planned = plans.get(agentID)?.shift();
        return planned ? planned(init.signal ?? undefined) : Response.json(agents.get(agentID));
      }
      const events = path.match(/^\/api\/admin\/agents\/([^/]+)\/events$/);
      if (events) {
        const agentID = decodeURIComponent(events[1]!);
        return Response.json({ events: [event(agentID, 101, "agent_created")], next_sequence: 101 });
      }
      const policy = path.match(/^\/api\/admin\/agents\/([^/]+)\/network-policy$/);
      if (policy) return Response.json({ agent_id: decodeURIComponent(policy[1]!), action: "deny_all", resource_version: 7, attachment: { state: "open", resource_version: 4 } });
      const progress = path.match(/^\/api\/admin\/operations\/create-(agent-[12])$/);
      if (progress) return Response.json(operation(progress[1]!));
      if (path === "/api/admin/templates") return Response.json({ items: [] });
      if (path === "/api/admin/directory") return Response.json({ users: [], groups: [] });
      unexpected.push(path);
      return Response.json({ code: "unexpected_request" }, { status: 503 });
    };
    const promise = run();
    pending.add(promise);
    const match = path.match(/^\/api\/admin\/agents\/([^/]+)$/);
    const read = match ? { agentID: decodeURIComponent(match[1]!), signal: init.signal ?? undefined, settled: false, promise } : undefined;
    if (read) agentReads.push(read);
    const settled = () => {
      pending.delete(promise);
      if (read) read.settled = true;
    };
    void promise.then(settled, settled);
    return promise;
  });
  vi.stubGlobal("fetch", fetch);
  const initialRead = holdInitial ? holdNext() : undefined;
  const page = render(<AgentsPage agentID="agent-1" networkScope={networkScope} />);
  const fixture = {
    agents,
    agentReads,
    streams,
    page,
    holdNext,
    initialRead,
    count(agentID = "agent-1") { return agentReads.filter((read) => read.agentID === agentID).length; },
    setReadiness(readiness: Readiness, agentID = "agent-1") {
      agents.set(agentID, { ...agents.get(agentID)!, readiness });
    },
    nextStatus(status: number) {
      enqueue("agent-1", async () => Response.json({ code: status === 503 ? "dependency_unavailable" : "agent_not_found", message: "Agent state read failed." }, { status }));
    },
    async emit(eventType: "runtime_bound" | "agent_ready", stream = streams[0]!) {
      sequence += 1;
      await act(async () => {
        stream.dispatchEvent(new MessageEvent("agent_event", {
          data: JSON.stringify(event("agent-1", sequence, eventType, 2)),
        }));
      });
    },
    close() {
      if (!closing) closing = (async () => {
        await act(async () => {
          page.unmount();
          for (const read of held) read.release();
          await Promise.allSettled(held.map((read) => read.promise));
          while (pending.size) await Promise.allSettled([...pending]);
        });
      })();
      return closing;
    },
    assertReadOnly() {
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      expect(unexpected).toEqual([]);
      expect(agentReads.every((read) => read.settled)).toBe(true);
    },
  };
  fixtures.push(fixture);
  if (!holdInitial) {
    await screen.findByRole("heading", { name: "Readiness Agent" });
    await screen.findByRole("heading", { name: "Last operation" });
  }
  await waitFor(() => expect(streams).toHaveLength(1));
  act(() => streams[0]!.onopen?.());
  return fixture;
}

type ReadinessFixture = Awaited<ReturnType<typeof readinessFixture>>;

function expectPreparing() {
  const status = screen.getByRole("status", { name: "Agent readiness" });
  expect(within(status).getByText(preparingMessage)).toBeTruthy();
  expect(within(status).queryByText(/^available$/i)).toBeNull();
}

function expectNoReadinessHint() {
  expect(screen.queryByRole("status", { name: "Agent readiness" })).toBeNull();
  expect(screen.queryByText(preparingMessage)).toBeNull();
  expect(screen.queryByText(unknownMessage)).toBeNull();
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

async function startPreparing(fixture: ReadinessFixture) {
  // Mount with real timers; only arm the preparing poll after the fake clock starts.
  vi.useFakeTimers();
  fixture.setReadiness("preparing");
  await fixture.emit("runtime_bound");
  expectPreparing();
}

async function usingFixture(action: (fixture: ReadinessFixture) => Promise<void>, initialReadiness?: Readiness) {
  const fixture = await readinessFixture(initialReadiness);
  try { await action(fixture); } finally { await fixture.close(); }
}

describe("Agent current readiness", () => {
  it("keeps preparing distinct from available Runtime health and a completed operation", async () => {
    await usingFixture(async () => {
      expectPreparing();
      expect(screen.getAllByText("completed", { exact: true }).length).toBeGreaterThan(0);
      // Runtime health remains an independent fact, rather than proof of readiness.
      expect(screen.getAllByText("available", { exact: true }).length).toBeGreaterThan(0);
    }, "preparing");
  });

  it("keeps omitted legacy readiness unknown without inventing readiness or polling", async () => {
    await usingFixture(async (fixture) => {
      expect(within(screen.getByRole("status", { name: "Agent readiness" })).getByText(unknownMessage)).toBeTruthy();
      vi.useFakeTimers();
      const before = fixture.count();
      await advance(5000);
      expect(fixture.count()).toBe(before);
      expect(screen.getByText(unknownMessage)).toBeTruthy();
    });
  });

  it("polls every second with a healthy stream and adopts same-sequence ready without another event", async () => {
    await usingFixture(async (fixture) => {
      await startPreparing(fixture);
      const before = fixture.count();
      await advance(999);
      expect(fixture.count()).toBe(before);
      await advance(1);
      expect(fixture.count()).toBe(before + 1);
      expectPreparing();
      await advance(1000);
      expect(fixture.count()).toBe(before + 2);
      fixture.setReadiness("ready");
      await advance(1000);
      expect(fixture.count()).toBe(before + 3);
      expectNoReadinessHint();
      await advance(5000);
      expect(fixture.count()).toBe(before + 3);
      expect(fixture.streams).toHaveLength(1);
      expect(fixture.streams[0]!.close).not.toHaveBeenCalled();
    });
  });

  it("does not overlap a held poll across timer ticks and resumes only after its actual settlement", async () => {
    await usingFixture(async (fixture) => {
      await startPreparing(fixture);
      const read = fixture.holdNext();
      const before = fixture.count();
      await advance(1000);
      expect(read.entered).toBe(true);
      expect(fixture.count()).toBe(before + 1);
      expect(fixture.agentReads.at(-1)!.settled).toBe(false);
      await advance(5000);
      expect(fixture.count()).toBe(before + 1);
      expectPreparing();
      await act(async () => { read.release(); await read.promise; });
      expect(fixture.agentReads.at(-1)!.settled).toBe(true);
      fixture.setReadiness("ready");
      await advance(999);
      expect(fixture.count()).toBe(before + 1);
      await advance(1);
      expect(fixture.count()).toBe(before + 2);
      expectNoReadinessHint();
    });
  });

  it.each(["runtime_bound", "agent_ready"] as const)("uses v2 %s only to reread current readiness", async (eventType) => {
    await usingFixture(async (fixture) => {
      await startPreparing(fixture);
      const read = fixture.holdNext();
      const before = fixture.count();
      await fixture.emit(eventType);
      expect(read.entered).toBe(true);
      expect(fixture.count()).toBe(before + 1);
      expectPreparing();
      await act(async () => { read.release(); await read.promise; });
      expectPreparing();
      fixture.setReadiness("ready");
      await fixture.emit(eventType);
      expect(fixture.count()).toBe(before + 2);
      expectNoReadinessHint();
    });
  });

  it("rejects an older preparing GET after newer ready, but accepts a fresh same-sequence unavailable", async () => {
    await usingFixture(async (fixture) => {
      await startPreparing(fixture);
      const oldRead = fixture.holdNext();
      const before = fixture.count();
      await fixture.emit("runtime_bound");
      expect(oldRead.entered).toBe(true);
      fixture.setReadiness("ready");
      await fixture.emit("agent_ready");
      expect(fixture.count()).toBe(before + 2);
      expectNoReadinessHint();
      await act(async () => { oldRead.release(); await oldRead.promise; });
      expectNoReadinessHint();
      fixture.setReadiness("unavailable");
      await fixture.emit("runtime_bound");
      expect(screen.getAllByText("unavailable", { exact: true }).length).toBeGreaterThan(0);
      expect(screen.queryByText(preparingMessage)).toBeNull();
      const settled = fixture.count();
      await advance(5000);
      expect(fixture.count()).toBe(settled);
    });
  });

  it("does not let a delayed initial GET overwrite a newer ready event refresh", async () => {
    const fixture = await readinessFixture("preparing", true);
    try {
      expect(fixture.initialRead!.entered).toBe(true);
      fixture.setReadiness("ready");
      await fixture.emit("agent_ready");
      expect(screen.getByRole("heading", { name: "Readiness Agent" })).toBeTruthy();
      expectNoReadinessHint();
      await act(async () => {
        fixture.initialRead!.release();
        await fixture.initialRead!.promise;
      });
      expectNoReadinessHint();
    } finally { await fixture.close(); }
  });

  it.each(["unmount", "Agent navigation", "networkScope navigation", "session generation", "cookie"])("aborts and joins a held poll after %s without late state or timers", async (boundary) => {
    await usingFixture(async (fixture) => {
      await startPreparing(fixture);
      const read = fixture.holdNext();
      await advance(1000);
      expect(read.entered).toBe(true);
      const actualRead = fixture.agentReads.at(-1)!;
      expect(read.signal).toBeDefined();
      expect(read.signal!.aborted).toBe(false);
      await act(async () => {
        if (boundary === "unmount") fixture.page.unmount();
        else if (boundary === "Agent navigation") fixture.page.rerender(<AgentsPage agentID="agent-2" networkScope={networkScope} />);
        else if (boundary === "networkScope navigation") {
          fixture.setReadiness("ready");
          fixture.page.rerender(<AgentsPage agentID="agent-1" networkScope={JSON.stringify(["org-2", "admin-2"])} />);
        } else if (boundary === "session generation") resetSessionRequests(testSession.principal);
        else {
          vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-antnest_csrf=other-tab");
          // A live callback observes the changed cookie, using the same public session guard.
          fixture.streams[0]!.onopen?.();
        }
      });
      expect(read.signal!.aborted).toBe(true);
      expect(actualRead.settled).toBe(false);
      expect(fixture.streams[0]!.close).toHaveBeenCalled();
      const afterInvalidation = document.body.textContent;
      const late = { ...agentSnapshot("agent-1", "ready"), name: "Stale scope response" };
      await act(async () => { read.release(Response.json(late)); await read.promise; });
      expect(fixture.agentReads.every((request) => request.settled)).toBe(true);
      expect(document.body.textContent).toBe(afterInvalidation);
      expect(screen.queryByRole("heading", { name: "Stale scope response" })).toBeNull();
      const afterJoin = fixture.agentReads.length;
      await advance(5000);
      expect(fixture.agentReads).toHaveLength(afterJoin);
    });
  });

  it.each([503, 403, 404])("handles preparing poll HTTP %s without mutation or false readiness", async (status) => {
    await usingFixture(async (fixture) => {
      await startPreparing(fixture);
      fixture.nextStatus(status);
      const before = fixture.count();
      await advance(1000);
      expect(fixture.count()).toBe(before + 1);
      expect(screen.queryByRole("heading", { name: "Readiness Agent" })).not.toBeNull();
      if (status === 503) {
        expectPreparing();
        fixture.setReadiness("ready");
        await advance(1000);
        expect(fixture.count()).toBe(before + 2);
        expectNoReadinessHint();
      } else {
        await advance(5000);
        expect(fixture.count()).toBe(before + 1);
      }
    });
  });
});
