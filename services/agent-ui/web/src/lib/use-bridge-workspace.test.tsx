import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useBridgeWorkspace } from "./use-bridge-workspace";
import { WorkspaceApiError } from "./workspace-api-client";

afterEach(cleanup);

test("leaving a Session releases completed process from published workspace history", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  let changed!: (snapshot: unknown) => void;
  const api = { bootstrap: async () => ({
    principal: { userId: "user-1", organizationId: "org-1", administrator: false },
    agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
      activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-25T00:00:00Z", bridgeEpoch: "epoch-1",
  }), sessions: async () => ({ items: [], nextCursor: null }) };
  const conversation = { id: "session-1", agentId: "agent-1", title: "Saved",
    updatedAt: "now", messages: [
      { id: "turn-1:prompt", role: "user", content: "Question", turnId: "turn-1",
        turnOutcome: "completed", processCount: 1, processLoaded: true },
      { id: "turn-1:process:tool-1", role: "tool", content: "large process body" },
      { id: "turn-1:answer", role: "assistant", content: "Answer" },
    ] };
  const snapshot = { connection: "ready", view: { agentId: "agent-1",
    bridgeEpoch: "epoch-1", availability: "ready", activeSessionId: null,
    selectedSessionId: "session-1", selectedView: { historyState: "ready" } },
    operations: [], permissions: [], conversation };
  const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
    makeController: (input) => {
      changed = input.changed as (snapshot: unknown) => void;
      return { snapshot, select: async () => { changed(snapshot); }, close: vi.fn() } as never;
    },
  }));
  await waitFor(() => expect(result.current.activeConversation?.messages)
    .toHaveLength(3));
  act(() => result.current.selectConversation("session-2"));
  expect(result.current.workspace?.conversations.find((item) => item.id === "session-1")
    ?.messages.map((item) => item.id)).toEqual(["turn-1:prompt", "turn-1:answer"]);
  act(() => changed(snapshot));
  expect(result.current.workspace?.conversations.find((item) => item.id === "session-1")
    ?.messages.map((item) => item.id)).toEqual(["turn-1:prompt", "turn-1:answer"]);
});

test("a missing Session deep link returns to the Agent directory", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=gone");
  const bootstrap = async () => ({
    principal: { userId: "user-1", organizationId: "org-1", administrator: false },
    agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
      activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-25T00:00:00Z", bridgeEpoch: "epoch-1",
  });
  const { result } = renderHook(() => useBridgeWorkspace({
    api: { bootstrap, sessions: async () => ({ items: [], nextCursor: null }) } as never,
    makeController: () => ({ select: async (sessionId: string | null) => {
      if (sessionId === "gone") throw new WorkspaceApiError("Session not found", 404,
        "session_not_found", "none");
    }, close: vi.fn(), snapshot: { connection: "offline", view: null,
      operations: [], permissions: [] } }) as never,
  }));
  await waitFor(() => expect(result.current.workspace?.activeConversationId).toBeNull());
  expect(result.current.workspace?.activeAgentId).toBe("agent-1");
  expect(window.location.search).toBe("?agent=agent-1");
});

test("Bridge workspace bootstraps through HTTP and observes the selected Agent", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1");
  const bootstrap = vi.fn(async () => ({
    principal: { userId: "user-1", organizationId: "org-1", administrator: false },
    agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
      activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1",
  }));
  const select = vi.fn(async () => {});
  const api = { bootstrap, sessions: vi.fn(async () => ({ items: [], nextCursor: null })) };
  const { result } = renderHook(() => useBridgeWorkspace({
    api: api as never,
    makeController: () => ({ select, close: vi.fn(),
      snapshot: { connection: "ready", view: null, operations: [], permissions: [] } }) as never,
  }));
  await waitFor(() => expect(result.current.workspace?.activeAgentId).toBe("agent-1"));
  await waitFor(() => expect(select).toHaveBeenCalledWith(null));
  expect(bootstrap).toHaveBeenCalledOnce();
  expect(result.current.workspace?.agents[0]?.name).toBe("Agent");
});

test("a disconnected observer keeps saved history but does not advertise stale availability", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  let changed!: (snapshot: unknown) => void;
  const conversation = { id: "session-1", agentId: "agent-1", title: "Saved",
    updatedAt: "now", messages: [{ id: "answer", role: "assistant", content: "Saved answer" }] };
  const snapshot = { connection: "ready", view: { agentId: "agent-1",
    bridgeEpoch: "epoch-1", availability: "ready", activeSessionId: null,
    selectedSessionId: "session-1", selectedView: { historyState: "ready" } },
    operations: [], permissions: [], conversation };
  const api = { bootstrap: async () => ({
    principal: { userId: "user-1", organizationId: "org-1", administrator: false },
    agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
      activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1",
  }), sessions: async () => ({ items: [], nextCursor: null }) };
  const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
    makeController: (input) => {
      changed = input.changed as (snapshot: unknown) => void;
      return { snapshot, select: async () => { changed(snapshot); }, close: vi.fn() } as never;
    },
  }));
  await waitFor(() => expect(result.current.activeAgent?.status).toBe("ready"));
  act(() => changed({ ...snapshot, connection: "offline" }));
  expect(result.current.activeAgent?.status).toBe("unknown");
  expect(result.current.activeConversation?.messages[0]?.content).toBe("Saved answer");
  expect(result.current.connected).toBe(false);
});

test("Bridge prompt clears the draft after HTTP admission while operation stays active", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  const bootstrap = async () => ({
    principal: { userId: "user-1", organizationId: "org-1", administrator: false },
    agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
      activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1",
  });
  const submitPrompt = vi.fn(async () => ({ operationId: "intent-1", sessionId: "session-1",
    phase: "dispatching", acceptance: "bridge" }));
  const api = { bootstrap, sessions: vi.fn(async () => ({ items: [], nextCursor: null })) };
  const { result } = renderHook(() => useBridgeWorkspace({
    api: api as never,
    makeController: ({ changed }) => {
      const snapshot = { connection: "ready", view: { agentId: "agent-1", bridgeEpoch: "epoch-1",
        promptCapabilities: {}, availability: "ready", activeSessionId: null,
        selectedSessionId: "session-1", selectedView: { historyState: "ready" } },
        operations: [], permissions: [], conversation: { id: "session-1", agentId: "agent-1",
          title: "Conversation", updatedAt: "now", messages: [] } };
      return { snapshot, select: async () => { changed(snapshot as never); },
        submitPrompt, close: vi.fn() } as never;
    },
  }));
  await waitFor(() => expect(result.current.conversationReady).toBe(true));
  act(() => result.current.setDraft("Hello"));
  await act(async () => { await result.current.submit(); });
  expect(submitPrompt).toHaveBeenCalledOnce();
  expect(result.current.draft).toBe("");
});

test("blocked selected View keeps saved messages read-only and offers retry", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  const select = vi.fn(async () => {});
  const api = { bootstrap: async () => ({
    principal: { userId: "user-1", organizationId: "org-1", administrator: false },
    agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
      activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1",
  }), sessions: vi.fn(async () => ({ items: [], nextCursor: null })) };
  const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
    makeController: ({ changed }) => {
      const snapshot = { connection: "ready", view: { agentId: "agent-1",
        bridgeEpoch: "epoch-1", availability: "ready", activeSessionId: null,
        selectedSessionId: "session-1", selectedView: { historyState: "blocked" } },
        operations: [], permissions: [], conversation: { id: "session-1", agentId: "agent-1",
          title: "Question", updatedAt: "now", historyState: "blocked",
          messages: [{ id: "turn:answer", role: "assistant", content: "Saved answer" }] } };
      return { snapshot, select: async (id: string | null) => {
        select(id); changed(snapshot as never);
      }, close: vi.fn() } as never;
    },
  }));
  await waitFor(() => expect(result.current.activeConversation?.messages[0]?.content)
    .toBe("Saved answer"));
  expect(result.current.conversationReady).toBe(false);
  expect(result.current.openingHistory).toBe(false);
  expect(result.current.history.error).toMatch(/saved messages/i);
  act(() => result.current.history.retry());
  await waitFor(() => expect(select).toHaveBeenCalledWith("session-1"));
});

test("Bridge Session switching preserves separate unsent drafts", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  const api = {
    bootstrap: async () => ({ principal: { userId: "user-1", organizationId: "org-1",
      administrator: false }, agents: [{ agentId: "agent-1", name: "Agent",
      lifecycle: "created", activation: "enabled", runtime: "available" }],
      renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1" }),
    sessions: async () => ({ items: [{ sessionId: "session-1", title: "One", updatedAt: "now",
      activeOperationId: null }, { sessionId: "session-2", title: "Two", updatedAt: "now",
      activeOperationId: null }], nextCursor: null }),
  };
  const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
    makeController: () => ({ select: async () => {}, close: vi.fn(),
      snapshot: { connection: "ready", view: null, operations: [], permissions: [] } }) as never }));
  await waitFor(() => expect(result.current.workspace?.activeConversationId).toBe("session-1"));
  act(() => result.current.setDraft("Draft one"));
  act(() => result.current.selectConversation("session-2"));
  await waitFor(() => expect(result.current.workspace?.activeConversationId).toBe("session-2"));
  expect(result.current.draft).toBe("");
  act(() => result.current.setDraft("Draft two"));
  act(() => result.current.selectConversation("session-1"));
  await waitFor(() => expect(result.current.workspace?.activeConversationId).toBe("session-1"));
  expect(result.current.draft).toBe("Draft one");
  act(() => result.current.selectConversation("session-2"));
  expect(result.current.draft).toBe("Draft two");
});

test("new Bridge Session remains in the catalog after navigation", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  const api = {
    bootstrap: async () => ({ principal: { userId: "user-1", organizationId: "org-1",
      administrator: false }, agents: [{ agentId: "agent-1", name: "Agent",
      lifecycle: "created", activation: "enabled", runtime: "available" }],
      renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1" }),
    sessions: async () => ({ items: [], nextCursor: null }),
    createSession: vi.fn(async () => ({ sessionId: "session-new" })),
  };
  const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
    makeController: () => ({ select: async () => {}, close: vi.fn(),
      snapshot: { connection: "ready", view: null, operations: [], permissions: [] } }) as never }));
  await waitFor(() => expect(result.current.workspace?.activeAgentId).toBe("agent-1"));
  await act(async () => { await result.current.newConversation(); });
  expect(result.current.workspace?.activeConversationId).toBe("session-new");
  expect(result.current.workspace?.conversations.some((item) => item.id === "session-new"))
    .toBe(true);
});

test("late Session creation does not replace a newer explicit selection", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  let finishCreation!: (value: { sessionId: string }) => void;
  const api = {
    bootstrap: async () => ({ principal: { userId: "user-1", organizationId: "org-1",
      administrator: false }, agents: [{ agentId: "agent-1", name: "Agent",
      lifecycle: "created", activation: "enabled", runtime: "available" }],
      renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1" }),
    sessions: async () => ({ items: [], nextCursor: null }),
    createSession: () => new Promise<{ sessionId: string }>((resolve) => {
      finishCreation = resolve;
    }),
  };
  const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
    makeController: () => ({ select: async () => {}, close: vi.fn(),
      snapshot: { connection: "ready", view: null, operations: [], permissions: [] } }) as never }));
  await waitFor(() => expect(result.current.workspace?.activeConversationId).toBe("session-1"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.newConversation(); });
  act(() => result.current.selectConversation("session-2"));
  await act(async () => { finishCreation({ sessionId: "session-new" }); await pending; });
  expect(result.current.workspace?.activeConversationId).toBe("session-2");
  expect(result.current.workspace?.conversations.some((item) => item.id === "session-new"))
    .toBe(true);
});

test("late hydration bootstrap retains a Session created after SSR", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1");
  const bootstrap = { principal: { userId: "user-1", organizationId: "org-1",
    administrator: false }, agents: [{ agentId: "agent-1", name: "Agent",
    lifecycle: "created", activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1" };
  let finishBootstrap!: (value: typeof bootstrap) => void;
  const api = {
    bootstrap: () => new Promise<typeof bootstrap>((resolve) => { finishBootstrap = resolve; }),
    sessions: async () => ({ items: [], nextCursor: null }),
    createSession: async () => ({ sessionId: "session-new" }),
  };
  const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
    initialBootstrap: bootstrap,
    makeController: () => ({ select: async () => {}, close: vi.fn(),
      snapshot: { connection: "ready", view: null, operations: [], permissions: [] } }) as never }));
  await act(async () => { await result.current.newConversation(); });
  expect(result.current.workspace?.conversations.some((item) => item.id === "session-new"))
    .toBe(true);
  await act(async () => { finishBootstrap(bootstrap); });
  expect(result.current.workspace?.activeConversationId).toBe("session-new");
  expect(result.current.workspace?.conversations.some((item) => item.id === "session-new"))
    .toBe(true);
});

test("refreshing into another principal clears private drafts for an overlapping Agent", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  let principal = "user-1";
  const select = vi.fn(async () => {});
  const api = {
    bootstrap: vi.fn(async () => ({ principal: { userId: principal,
      organizationId: "org-1", administrator: false },
      agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
        activation: "enabled", runtime: "available" }],
      renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1" })),
    sessions: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
    makeController: () => ({ select, close: vi.fn(),
      snapshot: { connection: "ready", view: null, operations: [], permissions: [] } }) as never }));
  await waitFor(() => expect(result.current.workspace?.principal.userId).toBe("user-1"));
  await waitFor(() => expect(select).toHaveBeenCalledWith("session-1"));
  const selectionsBeforeSwitch = select.mock.calls.length;
  act(() => result.current.setDraft("private draft from user one"));
  expect(result.current.draft).toBe("private draft from user one");

  principal = "user-2";
  await act(async () => { await result.current.refreshWorkspace(); });
  expect(result.current.workspace?.principal.userId).toBe("user-2");
  expect(result.current.draft).toBe("");
  expect(select).toHaveBeenCalledTimes(selectionsBeforeSwitch);
  act(() => result.current.selectAgent("agent-1"));
  act(() => result.current.selectConversation("session-1"));
  expect(result.current.draft).toBe("");
});

test("hydration bootstrap replacing the principal drops the SSR identity's draft", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  const bootstrapFor = (userId: string) => ({ principal: { userId,
    organizationId: "org-1", administrator: false },
    agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
      activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1" });
  let resolveBootstrap!: (value: ReturnType<typeof bootstrapFor>) => void;
  const api = { bootstrap: () => new Promise<ReturnType<typeof bootstrapFor>>((resolve) => {
    resolveBootstrap = resolve;
  }), sessions: async () => ({ items: [], nextCursor: null }) };
  const { result } = renderHook(() => useBridgeWorkspace({
    api: api as never, initialBootstrap: bootstrapFor("user-1"),
    makeController: () => ({ select: async () => {}, close: vi.fn(),
      snapshot: { connection: "ready", view: null, operations: [], permissions: [] } }) as never,
  }));
  act(() => result.current.setDraft("private SSR draft"));
  await act(async () => { resolveBootstrap(bootstrapFor("user-2")); });
  expect(result.current.workspace?.principal.userId).toBe("user-2");
  expect(result.current.draft).toBe("");
});

test("removing a Bridge attachment releases its preview URL before page unload", async () => {
  window.history.replaceState(null, "", "/workspace/?agent=agent-1&session=session-1");
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-one");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  try {
    const api = { bootstrap: async () => ({ principal: { userId: "user-1",
      organizationId: "org-1", administrator: false },
      agents: [{ agentId: "agent-1", name: "Agent", lifecycle: "created",
        activation: "enabled", runtime: "available" }],
      renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1" }),
      sessions: async () => ({ items: [], nextCursor: null }) };
    const { result } = renderHook(() => useBridgeWorkspace({ api: api as never,
      makeController: ({ changed }) => {
        const snapshot = { connection: "ready", view: { agentId: "agent-1",
          bridgeEpoch: "epoch-1", promptCapabilities: { image: true },
          availability: "ready", activeSessionId: null,
          selectedSessionId: "session-1", selectedView: { historyState: "ready" } },
          operations: [], permissions: [], conversation: { id: "session-1",
            agentId: "agent-1", title: "Conversation", updatedAt: "now", messages: [] } };
        return { snapshot, select: async () => { changed(snapshot as never); },
          close: vi.fn() } as never;
      } }));
    await waitFor(() => expect(result.current.conversationReady).toBe(true));
    act(() => result.current.addFiles([new File(["image"], "sample.png", { type: "image/png" })] as never));
    expect(create).toHaveBeenCalledOnce();
    const id = result.current.attachments[0]?.id;
    expect(id).toBeTruthy();
    act(() => result.current.removeAttachment(id!));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:preview-one"));
  } finally {
    create.mockRestore();
    revoke.mockRestore();
  }
});
