import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import BridgeApp from "./BridgeApp";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture(administrator: boolean, initialPreparing = false) {
  window.history.replaceState(null, "", "/workspace/agent-1/");
  vi.spyOn(document, "cookie", "get").mockReturnValue("antnest_csrf=preparing-test");
  const requests: { path: string; method: string; body?: unknown }[] = [];
  const sources: Array<{ closed: boolean; emit(name: string, event: unknown): void }> = [];
  let preparing = initialPreparing;
  const view = (sessionId: string | null = null, cursor = "cursor-1") => ({
    agentId: "agent-1", bridgeEpoch: "epoch-1", availability: preparing ? "offline" : "ready",
    unavailableReason: preparing ? "agent_preparing" : null,
    promptCapabilities: { embeddedContext: true }, activeSessionId: null,
    selectedSessionId: sessionId, operations: [], permissions: [], streamCursor: cursor,
    selectedView: sessionId === null ? null : {
      agentId: "agent-1", sessionId, bridgeEpoch: "epoch-1", incarnation: "incarnation-1",
      viewRevision: 1, appendVersion: 0, outputWatermark: 0, historyToken: "history-1",
      streamCursor: "session-cursor-1", historyState: "ready", title: null, updatedAt: null,
      turns: [], olderTurnsCursor: null, operations: [], permissions: [], configOptions: [],
      configurationToken: null, usage: null,
    },
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
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
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
      agents: [{ agentId: "agent-1", name: "New Agent", lifecycle: "created", activation: "enabled", runtime: "available" }],
      renderedAt: "2026-10-23T00:00:00Z", bridgeEpoch: "epoch-1",
    });
    if (path.endsWith("/sessions") && method === "GET") return Response.json({ items: [], nextCursor: null });
    if (path.endsWith("/sessions") && method === "POST") return Response.json({ sessionId: "session-1" }, { status: 201 });
    if (path.endsWith("/view")) return Response.json(view());
    if (path.endsWith("/view?sessionId=session-1")) return Response.json(view("session-1"));
    if (path.endsWith("/sessions/session-1/prompts") && method === "POST") return Response.json({
      operationId: (body as { intentId: string }).intentId, acceptance: "bridge", phase: "dispatching",
    }, { status: 202 });
    throw new Error(`Unexpected preparing request: ${method} ${path}`);
  }));
  const mounted = render(<BridgeApp />);
  return { requests, sources, mounted, setPreparing(value: boolean) { preparing = value; }, view };
}

test.each([true, false])("preparing retains draft and attachment without automatic submission; administrator=%s", async administrator => {
  const state = fixture(administrator);
  const originalText = "Keep this draft until I send it";
  const contents = "preserved attachment bytes";
  const file = new File([contents], "draft-context.txt", { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(contents).buffer });
  try {
    await screen.findByRole("heading", { name: "New Agent", level: 1 });
    await waitFor(() => expect(state.sources).toHaveLength(1));
    const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    fireEvent.change(editor, { target: { value: originalText } });
    fireEvent.change(screen.getByLabelText("File attachments"), { target: { files: [file] } });
    await screen.findByText(file.name);
    state.setPreparing(true);
    act(() => state.sources[0]!.emit("reset", {
      type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-1",
      fromStreamRevision: 0, toStreamRevision: 1, cursor: "cursor-2", view: state.view(null, "cursor-2"),
    }));
    expect(await screen.findByRole("status", { name: "Agent preparing" })).toBeTruthy();
    expect(screen.getByText("Preparing")).toBeTruthy();
    expect(screen.queryByText("Agent is offline")).toBeNull();
    expect(screen.queryByRole("link", { name: "Recover workspace" })).toBeNull();
    expect(screen.queryByText("Workspace recovery required")).toBeNull();
    expect(editor.value).toBe(originalText);
    expect(screen.getByText(file.name)).toBeTruthy();
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send message" });
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    await act(async () => {});
    expect(state.requests.filter(row => row.method === "POST")).toEqual([]);
    state.setPreparing(false);
    act(() => state.sources[0]!.emit("delta", {
      type: "delta", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-1",
      fromStreamRevision: 1, toStreamRevision: 2, fromCursor: "cursor-2", cursor: "cursor-3",
      sessionId: null, incarnation: null, fromSessionViewRevision: null, sessionViewRevision: null,
      patch: [{ op: "replace", path: "/availability", value: "ready" },
        { op: "replace", path: "/unavailableReason", value: null }],
    }));
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(screen.queryByRole("status", { name: "Agent preparing" })).toBeNull();
    expect(editor.value).toBe(originalText);
    expect(screen.getByText(file.name)).toBeTruthy();
    expect(state.requests.filter(row => row.method === "POST")).toEqual([]);
    fireEvent.click(send);
    await waitFor(() => expect(state.requests.filter(row => row.path.endsWith("/prompts"))).toHaveLength(1));
    expect(state.requests.filter(row => row.method === "POST" && row.path.endsWith("/sessions"))).toHaveLength(1);
    const prompt = state.requests.find(row => row.path.endsWith("/prompts"))!.body as { prompt: unknown[] };
    expect(prompt.prompt).toEqual([
      { type: "text", text: originalText },
      { type: "resource", resource: { uri: expect.any(String), mimeType: "text/plain", text: contents } },
    ]);
  } finally { state.mounted.unmount(); }
  expect(state.sources.every(source => source.closed)).toBe(true);
});

test("a newly opened preparing Agent shows waiting guidance without a recovery action or writes", async () => {
  const state = fixture(true, true);
  try {
    expect(await screen.findByRole("status", { name: "Agent preparing" })).toBeTruthy();
    expect(screen.getByText(/Your draft is kept/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Recover workspace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
    expect(state.requests.filter(row => row.method !== "GET")).toEqual([]);
  } finally { state.mounted.unmount(); }
  expect(state.sources.every(source => source.closed)).toBe(true);
});

test("preparing observed during attachment reading prevents the late Prompt and preserves its draft", async () => {
  const state = fixture(false);
  let release!: (bytes: ArrayBuffer) => void;
  let reading = false;
  const bytes = new TextEncoder().encode("held attachment").buffer;
  const held = new Promise<ArrayBuffer>(resolve => { release = resolve; });
  const file = new File([bytes], "held.txt", { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", { value: () => { reading = true; return held; } });
  try {
    await screen.findByRole("heading", { name: "New Agent", level: 1 });
    const editor = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    fireEvent.change(editor, { target: { value: "Wait for this attachment" } });
    fireEvent.change(screen.getByLabelText("File attachments"), { target: { files: [file] } });
    await screen.findByText(file.name);
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send message" });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(reading).toBe(true));
    expect(state.requests.filter(row => row.method === "POST" && row.path.endsWith("/sessions"))).toHaveLength(1);
    state.setPreparing(true);
    const source = state.sources.find(item => !item.closed)!;
    act(() => source.emit("reset", {
      type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-2",
      fromStreamRevision: 0, toStreamRevision: 1, cursor: "cursor-2", view: state.view("session-1", "cursor-2"),
    }));
    await screen.findByRole("status", { name: "Agent preparing" });
    await act(async () => { release(bytes); await held; });
    expect(state.requests.filter(row => row.path.endsWith("/prompts"))).toEqual([]);
    expect(editor.value).toBe("Wait for this attachment");
    expect(screen.getByText(file.name)).toBeTruthy();
    state.setPreparing(false);
    act(() => source.emit("reset", {
      type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-2",
      fromStreamRevision: 1, toStreamRevision: 2, cursor: "cursor-3", view: state.view("session-1", "cursor-3"),
    }));
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(state.requests.filter(row => row.path.endsWith("/prompts"))).toEqual([]);
    fireEvent.click(send);
    await waitFor(() => expect(state.requests.filter(row => row.path.endsWith("/prompts"))).toHaveLength(1));
    expect(state.requests.filter(row => row.method === "POST" && row.path.endsWith("/sessions"))).toHaveLength(1);
  } finally { release(bytes); state.mounted.unmount(); }
  expect(state.sources.every(source => source.closed)).toBe(true);
});
