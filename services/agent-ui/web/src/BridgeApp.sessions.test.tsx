import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import BridgeApp from "./BridgeApp";

const session = {
  principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1",
    organization_slug: "engineering", organization_name: "Engineering", system_role: "user",
    organization_role: "member", active: true },
  expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666,
};
const bootstrap = { principal: { organizationSlug: "engineering", organizationName: "Engineering",
  userId: "user-1", organizationId: "org-1", administrator: false }, agents: [],
  renderedAt: "2026-10-11T12:00:00Z", bridgeEpoch: "epoch-1" };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("SSR bootstrap does not start private requests before fresh browser validation", async () => {
  const response = deferred<Response>();
  const calls: string[] = [];
  vi.spyOn(document, "cookie", "get").mockReturnValue("antnest_csrf=csrf");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); calls.push(path);
    if (path === "/api/session") return response.promise;
    if (path.endsWith("/bootstrap")) return Response.json(bootstrap);
    throw new Error(`Unexpected ${path}`);
  }));
  const source = vi.fn(); vi.stubGlobal("EventSource", source);
  render(<BridgeApp initialBootstrap={bootstrap} initialRoute={{ agentId: "", sessionId: null }} />);
  await waitFor(() => expect(calls).toEqual(["/api/session"]));
  expect(source).not.toHaveBeenCalled();
  await act(async () => { response.resolve(Response.json(session)); });
  expect(await screen.findByText("No Agent available")).toBeTruthy();
  await waitFor(() => expect(calls).toEqual(["/api/session", "/api/app/workspace/v1/bootstrap"]));
});

test("StrictMode validates without publishing aborted setup or sharing private state", async () => {
  const calls: { path: string; signal?: AbortSignal | null }[] = [];
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-antnest_csrf=csrf");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, signal: init?.signal });
    if (path === "/api/session") return Response.json(session);
    if (path.endsWith("/bootstrap")) return Response.json(bootstrap);
    throw new Error(`Unexpected ${path}`);
  }));
  render(<StrictMode><BridgeApp /></StrictMode>);
  expect(await screen.findByText("No Agent available")).toBeTruthy();
  const validations = calls.filter(call => call.path === "/api/session");
  expect(validations).toHaveLength(2);
  expect(validations[0]?.signal?.aborted).toBe(true);
  expect(calls.findIndex(call => call.path.endsWith("/bootstrap"))).toBeGreaterThan(1);
});

test("a transient validation failure offers an explicit retry without an activity loop", async () => {
  let status = 503;
  const calls: string[] = [];
  vi.spyOn(document, "cookie", "get").mockReturnValue("antnest_csrf=csrf");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); calls.push(path);
    if (path === "/api/session") return Response.json(status === 200 ? session : { code: "unavailable", message: "Identity is temporarily unavailable." }, { status });
    if (path.endsWith("/bootstrap")) return Response.json(bootstrap);
    throw new Error(`Unexpected ${path}`);
  }));
  render(<BridgeApp />);
  expect(await screen.findByText("Identity is temporarily unavailable.")).toBeTruthy();
  expect(calls).toEqual(["/api/session"]);
  status = 200;
  fireEvent.click(screen.getByRole("button", { name: "Retry session verification" }));
  expect(await screen.findByText("No Agent available")).toBeTruthy();
  expect(calls).toEqual(["/api/session", "/api/session", "/api/app/workspace/v1/bootstrap"]);
});

test.each([false, true])("account controls are reachable before selecting an Agent (has agents: %s)", async hasAgents => {
  window.history.replaceState(null, "", "/workspace");
  vi.spyOn(document, "cookie", "get").mockReturnValue("antnest_csrf=csrf");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/session") return Response.json(session);
    if (String(input).endsWith("/bootstrap")) return Response.json({ ...bootstrap,
      agents: hasAgents ? [{ agentId: "agent-1", name: "Agent", lifecycle: "created", activation: "enabled", runtime: "available" }] : [] });
    throw new Error(`Unexpected ${input}`);
  }));
  render(<BridgeApp />);
  expect(await screen.findByRole("button", { name: "Account and sessions" })).toBeTruthy();
});

test("same user and Agent replacement rebuilds observation and releases private drafts and attachment URLs", async () => {
  window.history.replaceState(null, "", "/workspace/agent-1/sessions/session-1");
  let hint = "old";
  let reads = 0;
  const requests: string[] = [];
  const sources: Array<{ closed: boolean; emit(name: string, value: unknown): void }> = [];
  vi.spyOn(document, "cookie", "get").mockImplementation(() => `antnest_csrf=${hint}`);
  const revoke = vi.fn();
  const originalURL = URL;
  vi.stubGlobal("URL", class extends originalURL {
    static createObjectURL() { return "blob:old-private-attachment"; }
    static revokeObjectURL(url: string) { revoke(url); }
  });
  vi.stubGlobal("EventSource", class {
    closed = false;
    handlers = new Map<string, (event: { data: string }) => void>();
    constructor() { sources.push(this); }
    addEventListener(name: string, handler: (event: { data: string }) => void) { this.handlers.set(name, handler); }
    close() { this.closed = true; }
    emit(name: string, value: unknown) { this.handlers.get(name)?.({ data: JSON.stringify(value) }); }
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); requests.push(path);
    if (path === "/api/session") { reads++; return Response.json(session); }
    if (path.endsWith("/bootstrap")) return Response.json({ ...bootstrap,
      agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created", activation: "enabled", runtime: "available" }] });
    if (path.endsWith("/sessions")) return Response.json({ items: [{ sessionId: "session-1", title: "Conversation", updatedAt: "2026-10-11T12:00:00Z", activeOperationId: null }], nextCursor: null });
    if (path.includes("/view?sessionId=session-1")) return Response.json({
      agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "ready", promptCapabilities: { image: true },
      activeSessionId: null, selectedSessionId: "session-1", streamCursor: "cursor-1", operations: [], permissions: [],
      selectedView: { agentId: "agent-1", sessionId: "session-1", bridgeEpoch: "epoch-1", incarnation: "incarnation-1",
        viewRevision: 1, historyState: "ready", title: null, updatedAt: null, appendVersion: 1, historyToken: "history-1", outputWatermark: 1,
        streamCursor: "session-cursor-1", operations: [], permissions: [], configOptions: [], configurationToken: null, usage: null,
        turns: [{ turnId: "turn-1", outcome: "completed", prompt: [{ type: "text", text: "Saved question" }],
          finalResponse: [{ type: "text", text: reads === 1 ? "Old private answer" : "Fresh private answer" }],
          contentCursor: null, contentSection: null, processVersion: 0, processCount: 0 }], olderTurnsCursor: null },
    });
    throw new Error(`Unexpected ${path}`);
  }));
  render(<BridgeApp />);
  expect(await screen.findByText("Old private answer")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "Old unsent draft" } });
  fireEvent.change(screen.getByLabelText("File attachments"), { target: { files: [new File(["image"], "private.png", { type: "image/png" })] } });
  expect(screen.getByText("private.png")).toBeTruthy();
  expect(sources).toHaveLength(1);
  hint = "replacement";
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  expect(await screen.findByText("Fresh private answer")).toBeTruthy();
  expect(screen.queryByText("Old private answer")).toBeNull();
  expect(screen.queryByText("private.png")).toBeNull();
  expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe("");
  expect(revoke).toHaveBeenCalledWith("blob:old-private-attachment");
  expect(sources).toHaveLength(2);
  expect(sources[0]!.closed).toBe(true);
  expect(sources[1]!.closed).toBe(false);
  const count = requests.length;
  await act(async () => { sources[0]!.emit("error", {}); sources[0]!.emit("access_revoked", {}); });
  expect(requests).toHaveLength(count);
  expect(screen.getByText("Fresh private answer")).toBeTruthy();
  expect(reads).toBe(2);
});
