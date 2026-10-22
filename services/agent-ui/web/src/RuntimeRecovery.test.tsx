import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import BridgeApp from "./BridgeApp";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture(administrator: boolean) {
  window.history.replaceState(null, "", "/workspace/agent-1/");
  vi.spyOn(document, "cookie", "get").mockReturnValue("antnest_csrf=recovery-test");
  const requests: { path: string; method: string }[] = [];
  const sources: Array<{ closed: boolean; emit(name: string, event: unknown): void }> = [];
  const view = (agentId: string, reason: string | null = "runtime_barrier_required") => ({
    agentId, bridgeEpoch: "epoch-1", availability: reason === null ? "ready" : "offline",
    unavailableReason: reason, promptCapabilities: {}, activeSessionId: null,
    selectedSessionId: null, selectedView: null, operations: [], permissions: [],
    streamCursor: "cursor-1",
  });
  vi.stubGlobal("EventSource", class {
    closed = false;
    private listeners = new Map<string, (event: { data: string }) => void>();
    constructor() { sources.push(this); }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      this.listeners.set(name, listener);
    }
    emit(name: string, event: unknown) {
      if (!this.closed) this.listeners.get(name)?.({ data: JSON.stringify(event) });
    }
    close() { this.closed = true; this.listeners.clear(); }
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? "GET";
    requests.push({ path, method });
    if (path === "/api/session" && method === "GET") return Response.json({
      principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1",
        organization_slug: "engineering", organization_name: "Engineering", system_role: "user",
        organization_role: administrator ? "admin" : "member", active: true },
      expires_at: "2026-10-24T00:00:00Z", idle_expires_at: "2026-10-23T12:30:00Z", activity_interval_ms: 30_000,
    });
    if (path === "/api/session/external-identities?limit=50") return Response.json({ bindings: [], notices: [] });
    if (path.endsWith("/bootstrap")) return Response.json({
      principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user-1",
        organizationId: "org-1", administrator },
      agents: ["agent-1", "agent-2"].map(agentId => ({ agentId, name: agentId,
        lifecycle: "created", activation: "enabled", runtime: "available" })),
      renderedAt: "2026-10-23T00:00:00Z", bridgeEpoch: "epoch-1",
    });
    if (path.endsWith("/sessions")) return Response.json({ items: [], nextCursor: null });
    if (path.endsWith("/agents/agent-1/view")) return Response.json(view("agent-1"));
    if (path.endsWith("/agents/agent-2/view")) return Response.json(view("agent-2", null));
    throw new Error(`Unexpected recovery request: ${method} ${path}`);
  }));
  const mounted = render(<BridgeApp />);
  return { requests, sources, view, mounted };
}

test.each([true, false])("Runtime recovery reason survives healthy management state; administrator=%s", async administrator => {
  const state = fixture(administrator);
  try {
    expect(await screen.findByText("Workspace recovery required")).toBeTruthy();
    expect(screen.getByText(/An interrupted tool call requires workspace recovery/)).toBeTruthy();
    if (administrator) {
      expect(screen.getByRole("link", { name: "Recover workspace" }).getAttribute("href"))
        .toBe("/#agents/agent-1");
    } else {
      expect(screen.queryByRole("link", { name: "Recover workspace" })).toBeNull();
      expect(screen.getByText("Contact an organization administrator to recover this workspace.")).toBeTruthy();
    }
    expect(state.requests.filter(row => row.method !== "GET")).toEqual([]);
  } finally { state.mounted.unmount(); }
  expect(state.sources.every(source => source.closed)).toBe(true);
});

test("Runtime recovery reason clears on ready delta and access revocation", async () => {
  const state = fixture(true);
  try {
    expect(await screen.findByText("Workspace recovery required")).toBeTruthy();
    await waitFor(() => expect(state.sources).toHaveLength(1));
    act(() => state.sources[0]!.emit("delta", {
      type: "delta", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-1",
      fromStreamRevision: 1, toStreamRevision: 2, fromCursor: "cursor-1", cursor: "cursor-2",
      sessionId: null, incarnation: null, fromSessionViewRevision: null, sessionViewRevision: null,
      patch: [{ op: "replace", path: "/availability", value: "ready" },
        { op: "replace", path: "/unavailableReason", value: null }],
    }));
    await waitFor(() => expect(screen.queryByText("Workspace recovery required")).toBeNull());
    act(() => state.sources[0]!.emit("reset", {
      type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-1",
      fromStreamRevision: 2, toStreamRevision: 3, cursor: "cursor-3",
      view: { ...state.view("agent-1"), streamCursor: "cursor-3" },
    }));
    expect(await screen.findByText("Workspace recovery required")).toBeTruthy();
    act(() => state.sources[0]!.emit("access_revoked", {
      type: "access_revoked", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-1",
      fromStreamRevision: 3, toStreamRevision: 4, cursor: "cursor-4",
    }));
    await waitFor(() => expect(screen.queryByText("Workspace recovery required")).toBeNull());
    expect(screen.queryByRole("link", { name: "Recover workspace" })).toBeNull();
    expect(state.requests.filter(row => row.method !== "GET")).toEqual([]);
  } finally { state.mounted.unmount(); }
});

test("Runtime recovery guidance cannot follow a navigation to another Agent", async () => {
  const state = fixture(true);
  try {
    expect(await screen.findByText("Workspace recovery required")).toBeTruthy();
    const previous = state.sources[0]!;
    act(() => {
      window.history.replaceState(null, "", "/workspace/agent-2/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("agent-2"));
    expect(screen.queryByText("Workspace recovery required")).toBeNull();
    expect(screen.queryByRole("link", { name: "Recover workspace" })).toBeNull();
    expect(previous.closed).toBe(true);
    act(() => previous.emit("reset", {
      type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "old-projection",
      fromStreamRevision: 0, toStreamRevision: 1, cursor: "old-cursor",
      view: { ...state.view("agent-1"), streamCursor: "old-cursor" },
    }));
    expect(screen.queryByText("Workspace recovery required")).toBeNull();
    expect(state.requests.filter(row => row.method !== "GET")).toEqual([]);
  } finally { state.mounted.unmount(); }
});
