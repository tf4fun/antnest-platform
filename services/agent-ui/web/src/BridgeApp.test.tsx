import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import BridgeApp from "./BridgeApp";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each(["antnest_csrf", "__Host-antnest_csrf"])("Bridge page uses HTTP/SSE and %s for authenticated mutations", async (cookieName) => {
  window.history.replaceState(null, "", "/workspace/agent-1/sessions/session-1");
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", socket);
  const eventSources: string[] = [];
  let source!: { emit(name: string, value: unknown): void };
  vi.stubGlobal("EventSource", class {
    private listeners = new Map<string, (event: { data: string }) => void>();
    constructor(url: string) { eventSources.push(url); source = this; }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      this.listeners.set(name, listener);
    }
    emit(name: string, value: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
    close() {}
  });
  const requests: string[] = [];
  const prompts: { body: unknown; headers: Headers }[] = [];
  const logouts: RequestInit[] = [];
  let initialView: Record<string, unknown>;
  vi.spyOn(document, "cookie", "get").mockReturnValue(cookieName.startsWith("__Host-")
    ? "antnest_csrf=planted; __Host-antnest_csrf=csrf-test"
    : "antnest_csrf=csrf-test");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/bootstrap")) return Response.json({
      principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user-1", organizationId: "org-1", administrator: false },
      agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
        activation: "enabled", runtime: "available" }],
      renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1",
    });
    if (url.endsWith("/sessions")) return Response.json({
      items: [{ sessionId: "session-1", title: "Question", updatedAt: "2026-09-23T00:00:00Z",
        activeOperationId: null }], nextCursor: null,
    });
    if (url.includes("/view?sessionId=session-1")) return Response.json(initialView = {
      agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "ready",
      promptCapabilities: { image: true }, activeSessionId: null,
      selectedSessionId: "session-1", streamCursor: "cursor-1",
      operations: [], permissions: [],
      selectedView: { agentId: "agent-1", sessionId: "session-1", bridgeEpoch: "epoch-1",
        incarnation: "incarnation-1", viewRevision: 1, historyState: "ready", title: null, updatedAt: null,
        appendVersion: 1, historyToken: "token-1", outputWatermark: 1,
        streamCursor: "session-cursor-1", operations: [], permissions: [],
        configOptions: [], configurationToken: null, usage: null,
        turns: [{ turnId: "turn-1", outcome: "completed",
          prompt: [{ type: "text", text: "Question" }],
          finalResponse: [{ type: "text", text: "Answer" }], contentCursor: null, contentSection: null,
          processVersion: 0, processCount: 0 }], olderTurnsCursor: null },
    });
    if (url.endsWith("/sessions/session-1/prompts")) {
      prompts.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return Response.json({ operationId: (prompts.at(-1)?.body as { intentId: string }).intentId,
        acceptance: "bridge", phase: "dispatching" }, { status: 202 });
    }
    if (url === "/api/session" && init?.method === "DELETE") {
      logouts.push(init);
      return new Response(null, { status: 503 });
    }
    throw new Error(`Unexpected Bridge request ${url}`);
  }));
  render(<BridgeApp />);
  expect(await screen.findByText("Answer")).toBeTruthy();
  expect(screen.getAllByText("Question").length).toBeGreaterThan(0);
  expect(socket).not.toHaveBeenCalled();
  expect(requests.some((url) => url.includes("/v1/acp"))).toBe(false);
  expect(eventSources).toEqual([expect.stringContaining("/agents/agent-1/events")]);
  fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "Next question" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(prompts).toHaveLength(1));
  expect(prompts[0]?.headers.get("X-Antnest-CSRF-Token")).toBe("csrf-test");
  expect((prompts[0]?.body as { prompt: { text: string }[] }).prompt).toEqual([
    { type: "text", text: "Next question" },
  ]);
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe(""));
  expect(screen.getByRole("button", { name: "Stop operation" })).toHaveProperty("disabled", true);
  const completedView = structuredClone(initialView);
  completedView.streamCursor = "cursor-2";
  completedView.selectedView = {
    ...(completedView.selectedView as Record<string, unknown>), viewRevision: 2,
    operations: [{ operationId: (prompts[0]?.body as { intentId: string }).intentId,
      sessionId: "session-1", phase: "completed", acceptance: "acp",
      runId: "run-1", outputWatermark: 2 }],
    turns: [{ turnId: "turn-1", outcome: "completed",
      prompt: [{ type: "text", text: "Question" }],
      finalResponse: [{ type: "text", text: "Answer finished" }],
      contentCursor: null, contentSection: null, processVersion: 0, processCount: 0 }],
  };
  source.emit("reset", { type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1",
    projectionId: "projection-1", fromStreamRevision: 0, toStreamRevision: 1,
    cursor: "cursor-2", view: completedView });
  expect(await screen.findByText("Answer finished")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop operation" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByText("Your session could not be closed.")).toBeTruthy();
  expect(logouts).toHaveLength(1);
  expect(new Headers(logouts[0]?.headers).get("X-Antnest-CSRF-Token")).toBe("csrf-test");
  expect(logouts[0]?.credentials).toBe("same-origin");
  expect(screen.getByText("Answer finished")).toBeTruthy();
  source.emit("access_revoked", { type: "access_revoked", agentId: "agent-1",
    bridgeEpoch: "epoch-1", projectionId: "projection-1",
    fromStreamRevision: 1, toStreamRevision: 2, cursor: "cursor-3" });
  expect(await screen.findByText("No Agent available")).toBeTruthy();
  expect(screen.queryByText("Answer finished")).toBeNull();
});
