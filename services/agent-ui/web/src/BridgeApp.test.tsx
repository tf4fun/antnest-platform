import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    if (url === "/api/session" && init?.method === "GET") return Response.json({
      principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1",
        organization_slug: "engineering", organization_name: "Engineering", system_role: "user", organization_role: "member", active: true },
      expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666,
    });
    if (url === "/api/session/external-identities?limit=50") return Response.json({ bindings: [], notices: [] });
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

test("Bridge page explicitly retries the original Prompt with its attachment after querying and refreshing its token", async () => {
  window.history.replaceState(null, "", "/workspace/agent-1/sessions/session-1");
  type PromptBody = { intentId: string; expectedAppendVersion: number; prompt: unknown[] };
  type RequestRow = { path: string; method: string; headers: Headers; body?: PromptBody };
  const held = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
  };
  const releaseQuery = held<void>();
  const releaseView = held<void>();
  const releaseRetry = held<void>();
  const requests: RequestRow[] = [];
  const prompts: RequestRow[] = [];
  const pendingFetches = new Set<Promise<Response>>();
  const sources: Array<{ closed: boolean; emit(name: string, value: unknown): void; close(): void }> = [];
  const sessionPath = "/api/app/workspace/v1/agents/agent-1/sessions/session-1";
  const viewPath = "/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1";
  let retryClicked = false;
  let firstBody: PromptBody | undefined;
  let clickIndex = 0;
  let queryHeldRequests: string[] = [];
  let viewHeldRequests: string[] = [];
  let finalDraft = "";
  let finalAttachmentVisible = false;
  let completedVisible = false;
  let sourcesClosedByUnmount = false;
  let mounted: ReturnType<typeof render> | undefined;
  const cookie = vi.spyOn(document, "cookie", "get").mockReturnValue("antnest_csrf=csrf-original-retry");
  const originalText = "Send original message A";
  const originalFile = new File(["Original A attachment"], "original-a.txt", { type: "text/plain" });
  const readOriginalFile = vi.fn(async () => new TextEncoder().encode("Original A attachment").buffer);
  Object.defineProperty(originalFile, "arrayBuffer", { value: readOriginalFile });
  const changedFile = new File(["Different current attachment"], "current-draft.txt", { type: "text/plain" });
  const readChangedFile = vi.fn(async () => new TextEncoder().encode("Different current attachment").buffer);
  Object.defineProperty(changedFile, "arrayBuffer", { value: readChangedFile });
  const unknownOperation = () => ({
    operationId: firstBody?.intentId ?? "not-submitted", sessionId: "session-1",
    phase: "uncertain", acceptance: "unknown",
    error: { code: "agent_busy", message: "The Agent is busy.", requestId: "busy-original-a",
      operationId: firstBody?.intentId ?? "not-submitted", retryable: false, recovery: "query_operation" },
  });
  const view = (version: number, operations: unknown[] = [], completed = false) => ({
    agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "ready",
    promptCapabilities: { image: true, embeddedContext: true }, activeSessionId: null,
    selectedSessionId: "session-1", streamCursor: `cursor-${version}`,
    operations, permissions: [],
    selectedView: { agentId: "agent-1", sessionId: "session-1", bridgeEpoch: "epoch-1",
      incarnation: "incarnation-1", viewRevision: version, historyState: "ready", title: null, updatedAt: null,
      appendVersion: version >= 3 ? 2 : 1, historyToken: version >= 3 ? "history-refreshed-2" : "history-original-1",
      outputWatermark: completed ? 2 : 1, streamCursor: `session-cursor-${version}`,
      operations, permissions: [], configOptions: [], configurationToken: null, usage: null,
      turns: [{ turnId: completed ? "run-original-a" : "saved-turn", outcome: "completed",
        prompt: completed ? firstBody?.prompt ?? [] : [{ type: "text", text: "Saved question" }],
        finalResponse: [{ type: "text", text: completed ? "Original A retry completed" : "Saved answer" }],
        contentCursor: null, contentSection: null, processVersion: 0, processCount: 0 }],
      olderTurnsCursor: null },
  });
  const relevantAfterClick = () => requests.slice(clickIndex).filter(row =>
    row.path === viewPath || row.path.startsWith(`${sessionPath}/operations/`) ||
    row.path.startsWith(`${sessionPath}/prompts`)).map(row => `${row.method} ${row.path}`);
  vi.stubGlobal("EventSource", class {
    closed = false;
    private listeners = new Map<string, (event: { data: string }) => void>();
    constructor() { sources.push(this); }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      this.listeners.set(name, listener);
    }
    emit(name: string, value: unknown) {
      if (!this.closed) this.listeners.get(name)?.({ data: JSON.stringify(value) });
    }
    close() { this.closed = true; this.listeners.clear(); }
  });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const row: RequestRow = { path, method: init?.method ?? "GET", headers: new Headers(init?.headers) };
    requests.push(row);
    const task = (async () => {
      if (path === "/api/session" && row.method === "GET") return Response.json({
        principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1",
          organization_slug: "engineering", organization_name: "Engineering", system_role: "user",
          organization_role: "member", active: true },
        expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666,
      });
      if (path === "/api/session/external-identities?limit=50") return Response.json({ bindings: [], notices: [] });
      if (path.endsWith("/bootstrap")) return Response.json({
        principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user-1",
          organizationId: "org-1", administrator: false },
        agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created", activation: "enabled", runtime: "available" }],
        renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1",
      });
      if (path.endsWith("/sessions")) return Response.json({
        items: [{ sessionId: "session-1", title: "Conversation", updatedAt: "2026-09-23T00:00:00Z", activeOperationId: null }],
        nextCursor: null,
      });
      if (path === viewPath) {
        if (retryClicked) { await releaseView.promise; return Response.json(view(3, [unknownOperation()])); }
        return Response.json(view(1));
      }
      if (path === `${sessionPath}/operations/${encodeURIComponent(firstBody?.intentId ?? "not-submitted")}` && row.method === "GET") {
        await releaseQuery.promise;
        return Response.json(unknownOperation());
      }
      if (path.startsWith(`${sessionPath}/prompts`) && row.method === "POST") {
        row.body = JSON.parse(String(init?.body)) as PromptBody;
        prompts.push(row);
        if (prompts.length === 1) firstBody = structuredClone(row.body);
        else await releaseRetry.promise;
        return Response.json({ operationId: row.body.intentId, acceptance: "bridge", phase: "dispatching" }, { status: 202 });
      }
      throw new Error(`Unexpected original retry request ${path}`);
    })();
    pendingFetches.add(task);
    void task.then(() => pendingFetches.delete(task), () => pendingFetches.delete(task));
    return task;
  }));
  try {
    mounted = render(<BridgeApp />);
    await screen.findByText("Saved answer");
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: originalText } });
    fireEvent.change(screen.getByLabelText("File attachments"), { target: { files: [originalFile] } });
    await screen.findByText(originalFile.name);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(prompts).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe(""));
    await act(async () => {
      sources.at(-1)!.emit("reset", { type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1",
        projectionId: "projection-original-retry", fromStreamRevision: 0, toStreamRevision: 1,
        cursor: "cursor-2", view: view(2, [unknownOperation()]) });
    });
    await screen.findByText(/Message status is uncertain\./u);
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "A different unsent draft" } });
    fireEvent.change(screen.getByLabelText("File attachments"), { target: { files: [changedFile] } });
    await screen.findByText(changedFile.name);
    // The current baseline reaches this rendered business action before failing:
    // no invented controller/API method is needed to make this a red test.
    const retry = await screen.findByRole("button", { name: "Retry original message" });
    clickIndex = requests.length;
    retryClicked = true;
    await act(async () => { fireEvent.click(retry); fireEvent.click(retry); });
    await waitFor(() => expect(requests.some(row => row.method === "GET" &&
      row.path === `${sessionPath}/operations/${encodeURIComponent(firstBody!.intentId)}`)).toBe(true));
    queryHeldRequests = relevantAfterClick();
    await act(async () => { releaseQuery.resolve(); });
    await waitFor(() => expect(requests.slice(clickIndex).some(row => row.path === viewPath)).toBe(true));
    viewHeldRequests = relevantAfterClick();
    await act(async () => { releaseView.resolve(); });
    await waitFor(() => expect(prompts).toHaveLength(2));
    await act(async () => { releaseRetry.resolve(); });
    await act(async () => {
      sources.filter(source => !source.closed).at(-1)!.emit("reset", {
        type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-original-retry",
        fromStreamRevision: 1, toStreamRevision: 2, cursor: "cursor-4",
        view: view(4, [{ operationId: firstBody!.intentId, sessionId: "session-1", acceptance: "acp",
          phase: "completed", runId: "run-original-a", outputWatermark: 2, stopReason: "end_turn", errorClass: null }], true),
      });
    });
    await screen.findByText("Original A retry completed");
    completedVisible = true;
    finalDraft = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value;
    finalAttachmentVisible = screen.queryByText(changedFile.name) !== null;
  } finally {
    await act(async () => {
      mounted?.unmount();
      cleanup();
      sourcesClosedByUnmount = sources.length > 0 && sources.every(source => source.closed);
      releaseQuery.resolve(); releaseView.resolve(); releaseRetry.resolve();
      while (pendingFetches.size) await Promise.allSettled([...pendingFetches]);
    });
    for (const source of sources) source.close();
    cookie.mockRestore();
  }
  const operationPath = `${sessionPath}/operations/${encodeURIComponent(firstBody!.intentId)}`;
  expect(queryHeldRequests).toEqual([`GET ${operationPath}`]);
  expect(viewHeldRequests).toEqual([`GET ${operationPath}`, `GET ${viewPath}`]);
  expect(relevantAfterClick()).toEqual([
    `GET ${operationPath}`, `GET ${viewPath}`, `POST ${sessionPath}/prompts?action=retry`,
  ]);
  expect(prompts).toHaveLength(2);
  expect(firstBody).toEqual({ intentId: expect.any(String), expectedAppendVersion: 1,
    prompt: [{ type: "text", text: originalText },
      { type: "resource", resource: { uri: "attachment:///original-a.txt", mimeType: "text/plain", text: "Original A attachment" } }] });
  expect(prompts[1]!.body).toEqual(firstBody);
  expect(prompts[0]!.headers.get("If-Match")).toBe("history-original-1");
  expect(prompts[1]!.headers.get("If-Match")).toBe("history-refreshed-2");
  for (const prompt of prompts) {
    expect(prompt.headers.get("Idempotency-Key")).toBe(firstBody!.intentId);
    expect(prompt.headers.get("X-Antnest-CSRF-Token")).toBe("csrf-original-retry");
  }
  expect(readOriginalFile).toHaveBeenCalledTimes(1);
  expect(readChangedFile).not.toHaveBeenCalled();
  expect(finalDraft).toBe("A different unsent draft");
  expect(finalAttachmentVisible).toBe(true);
  expect(completedVisible).toBe(true);
  expect(sourcesClosedByUnmount).toBe(true);
  expect(pendingFetches.size).toBe(0);
});

function promptNavigationFixture(holdPrompt = false) {
  window.history.replaceState(null, "", "/workspace/agent-1/sessions/session-1");
  vi.spyOn(document, "cookie", "get").mockReturnValue("antnest_csrf=csrf-test");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  const sources: { closed: boolean; emit(name: string, value: unknown): void }[] = [];
  vi.stubGlobal("EventSource", class {
    closed = false;
    private listeners = new Map<string, (event: { data: string }) => void>();
    constructor() { sources.push(this); }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      this.listeners.set(name, listener);
    }
    emit(name: string, value: unknown) {
      if (!this.closed) this.listeners.get(name)?.({ data: JSON.stringify(value) });
    }
    close() { this.closed = true; }
  });
  const prompts: { intentId: string; expectedAppendVersion: number; prompt: unknown[] }[] = [];
  const sessionPosts: unknown[] = [];
  const viewReads: { sessionId: string | null; operationIds: string[] }[] = [];
  const requests: { url: string; method: string }[] = [];
  let operations: { operationId: string; sessionId: string; phase: string; acceptance: string;
    error: { code: string; message: string; requestId: string; operationId: string;
      retryable: boolean; recovery: string } }[] = [];
  let releasePrompt = () => {};
  const promptGate = holdPrompt ? new Promise<void>(resolve => { releasePrompt = resolve; }) : Promise.resolve();
  let promptSettled = false;
  const pending = new Set<Promise<Response>>();
  const view = (sessionId: string | null, cursor = "cursor-1") => ({
    agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "ready",
    promptCapabilities: {}, activeSessionId: null, selectedSessionId: sessionId,
    streamCursor: cursor, operations: structuredClone(operations), permissions: [],
    selectedView: sessionId === null ? null : {
      agentId: "agent-1", sessionId, bridgeEpoch: "epoch-1", incarnation: "incarnation-1",
      viewRevision: 1, historyState: "ready", title: null, updatedAt: null,
      appendVersion: 1, historyToken: "token-1", outputWatermark: 1,
      streamCursor: "session-cursor-1", operations: structuredClone(operations), permissions: [],
      configOptions: [], configurationToken: null, usage: null,
      turns: [{ turnId: "turn-1", outcome: "completed",
        prompt: [{ type: "text", text: "Question" }],
        finalResponse: [{ type: "text", text: "Answer" }], contentCursor: null, contentSection: null,
        processVersion: 0, processCount: 0 }], olderTurnsCursor: null,
    },
  });
  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url === "/api/session" && method === "GET") return Response.json({
      principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1",
        organization_slug: "engineering", organization_name: "Engineering", system_role: "user",
        organization_role: "member", active: true },
      expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666,
    });
    if (url === "/api/session/external-identities?limit=50") return Response.json({ bindings: [], notices: [] });
    if (url.endsWith("/bootstrap")) return Response.json({
      principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user-1",
        organizationId: "org-1", administrator: false },
      agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created", activation: "enabled", runtime: "available" }],
      renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1",
    });
    if (url.endsWith("/sessions") && method === "POST") {
      sessionPosts.push(init?.body);
      return Response.json({ sessionId: "unexpected-session" });
    }
    if (url.endsWith("/sessions") && method === "GET") return Response.json({
      items: [{ sessionId: "session-1", title: "Question", updatedAt: "2026-09-23T00:00:00Z",
        activeOperationId: operations[0]?.operationId ?? null }], nextCursor: null,
    });
    const parsed = new URL(url, window.location.origin);
    if (parsed.pathname.endsWith("/view") && method === "GET") {
      const sessionId = parsed.searchParams.get("sessionId");
      viewReads.push({ sessionId, operationIds: operations.map(item => item.operationId) });
      return Response.json(view(sessionId));
    }
    if (url.endsWith("/sessions/session-1/prompts") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as (typeof prompts)[number];
      prompts.push(body);
      await promptGate;
      promptSettled = true;
      return Response.json({ operationId: body.intentId, acceptance: "bridge", phase: "dispatching" }, { status: 202 });
    }
    throw new Error(`Unexpected Bridge request ${method} ${url}`);
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const response = respond(input, init);
    pending.add(response);
    void response.then(() => pending.delete(response), () => pending.delete(response));
    return response;
  }));
  return {
    prompts, sessionPosts, requests, viewReads, sources, releasePrompt,
    get promptSettled() { return promptSettled; },
    get pendingRequests() { return pending.size; },
    async join() { while (pending.size) await Promise.allSettled([...pending]); },
    uncertain() {
      const original = prompts[0]!;
      operations = [{ operationId: original.intentId, sessionId: "session-1", phase: "uncertain",
        acceptance: "unknown", error: { code: "agent_busy", message: "The Agent is busy. Try again shortly.",
          requestId: "request-1", operationId: original.intentId, retryable: false, recovery: "query_operation" } }];
      sources.at(-1)!.emit("reset", { type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1",
        projectionId: "projection-1", fromStreamRevision: 0, toStreamRevision: 1,
        cursor: "cursor-2", view: view("session-1", "cursor-2") });
    },
  };
}

test("settled uncertain Prompt permits read-only refresh and both local new-conversation controls", async () => {
  const fixture = promptNavigationFixture();
  const page = render(<BridgeApp />);
  try {
    expect(await screen.findByText("Answer")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "Original message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(fixture.prompts).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe(""));
    expect(fixture.promptSettled).toBe(true);
    const original = structuredClone(fixture.prompts[0]!);
    act(() => fixture.uncertain());
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("original operation"));
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "Keep the original Session draft" } });
    expect(screen.getByRole("button", { name: "Stop operation" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Message" }), { key: "Enter", code: "Enter" });
    expect(fixture.prompts).toEqual([original]);
    expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe("Keep the original Session draft");
    const newConversationButtons = screen.getAllByRole("button", { name: "New conversation", exact: true });
    expect(newConversationButtons).toHaveLength(2);
    for (const button of newConversationButtons) expect(button).toHaveProperty("disabled", false);
    const refresh = screen.getByRole("button", { name: "Refresh workspace" });
    expect(refresh).toHaveProperty("disabled", false);
    const readsBeforeRefresh = fixture.viewReads.length;
    fireEvent.click(refresh);
    await waitFor(() => expect(fixture.viewReads.length).toBeGreaterThan(readsBeforeRefresh));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh workspace" })).toHaveProperty("disabled", false));
    expect(fixture.viewReads.at(-1)).toEqual({ sessionId: "session-1", operationIds: [original.intentId] });
    expect(screen.getByRole("alert")).toHaveProperty("textContent", expect.stringContaining("original operation"));
    expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe("Keep the original Session draft");
    for (let index = 0; index < 2; index++) {
      const buttons = screen.getAllByRole("button", { name: "New conversation", exact: true });
      expect(buttons[index]).toHaveProperty("disabled", false);
      fireEvent.click(buttons[index]!);
      await waitFor(() => expect(window.location.pathname).toBe("/workspace/agent-1/"));
      await waitFor(() => expect(fixture.viewReads.at(-1)?.sessionId).toBeNull());
      expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe("");
      expect(fixture.viewReads.at(-1)?.operationIds).toEqual([original.intentId]);
      expect(fixture.sessionPosts).toHaveLength(0);
      expect(fixture.prompts).toEqual([original]);
      fireEvent.click(screen.getByRole("button", { name: /Question/ }));
      await waitFor(() => expect(window.location.pathname).toBe("/workspace/agent-1/sessions/session-1"));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveProperty("textContent", expect.stringContaining("original operation")));
      expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe("Keep the original Session draft");
      expect(screen.getByRole("button", { name: "Stop operation" })).toHaveProperty("disabled", true);
    }
    expect(fixture.sessionPosts).toHaveLength(0);
    expect(fixture.prompts).toEqual([original]);
  } finally {
    try { await act(async () => { fixture.releasePrompt(); await fixture.join(); }); }
    finally { page.unmount(); await fixture.join(); }
  }
  expect(fixture.pendingRequests).toBe(0);
  expect(fixture.sources.every(source => source.closed)).toBe(true);
});

test("held original Prompt HTTP keeps refresh and both new-conversation controls disabled until settlement", async () => {
  const fixture = promptNavigationFixture(true);
  const page = render(<BridgeApp />);
  try {
    expect(await screen.findByText("Answer")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "Held original message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(fixture.prompts).toHaveLength(1));
    expect(fixture.promptSettled).toBe(false);
    const original = structuredClone(fixture.prompts[0]!);
    const reads = fixture.viewReads.length;
    const requests = fixture.requests.length;
    const buttons = screen.getAllByRole("button", { name: "New conversation", exact: true });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveProperty("disabled", true);
      fireEvent.click(button);
    }
    const refresh = screen.getByRole("button", { name: "Refresh workspace" });
    expect(refresh).toHaveProperty("disabled", true);
    fireEvent.click(refresh);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Message" }), { key: "Enter", code: "Enter" });
    expect(window.location.pathname).toBe("/workspace/agent-1/sessions/session-1");
    expect(fixture.viewReads).toHaveLength(reads);
    expect(fixture.requests).toHaveLength(requests);
    expect(fixture.sessionPosts).toHaveLength(0);
    expect(fixture.prompts).toEqual([original]);
    await act(async () => { fixture.releasePrompt(); await fixture.join(); });
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe(""));
    expect(fixture.promptSettled).toBe(true);
    expect(fixture.sessionPosts).toHaveLength(0);
    expect(fixture.prompts).toEqual([original]);
  } finally {
    try { await act(async () => { fixture.releasePrompt(); await fixture.join(); }); }
    finally { page.unmount(); await fixture.join(); }
  }
  expect(fixture.pendingRequests).toBe(0);
  expect(fixture.sources.every(source => source.closed)).toBe(true);
});
