import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useBridgeWorkspace } from "./use-bridge-workspace";
import { controlCatalogue } from "../../server/src/protocol/workspace-commands.ts";

afterEach(cleanup);
async function setup(sessionId: string | null = null, busy = false) {
  window.history.replaceState(null, "", `/workspace/agent/${sessionId ? `sessions/${sessionId}` : ""}`);
  const api = {
    bootstrap: async () => ({ principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user", organizationId: "org", administrator: false },
      agents: [{ agentId: "agent", name: "Agent", lifecycle: "created", activation: "enabled", runtime: "available" }], renderedAt: "now", bridgeEpoch: "epoch" }),
    sessions: async () => ({ items: [], nextCursor: null }),
    createSession: vi.fn(),
    control: vi.fn(async () => ({ command: "help", text: "Available commands" })),
  };
  const submitPrompt = vi.fn(); const cancelOperation = vi.fn();
  const { result, unmount } = renderHook(() => useBridgeWorkspace({ api: api as never, makeController: ({ changed }) => {
    const snapshot = (selected: string | null): any => ({ connection: "ready", view: { agentId: "agent", bridgeEpoch: "epoch",
      availability: busy ? "busy" : "ready", activeSessionId: busy ? "session" : null,
      selectedSessionId: selected, selectedView: selected ? { historyState: "ready", configurationToken: "token" } : null,
      controlCommands: controlCatalogue(null, false) }, operations: busy ? [{ operationId: "intent", sessionId: "session", runId: "run", phase: "running" }] : [], permissions: [] });
    const controller = { snapshot: snapshot(sessionId), submitPrompt, cancelOperation, close: vi.fn(),
      async select(id: string | null) { controller.snapshot = snapshot(id); changed(controller.snapshot); } };
    return controller as never;
  } }));
  await waitFor(() => expect(result.current.connected).toBe(true));
  return { result, unmount, api, submitPrompt, cancelOperation };
}

test("draft help uses a control request without creating a Session or model prompt", async () => {
  const { result, api, submitPrompt } = await setup();
  act(() => result.current.setDraft("/help"));
  await act(async () => { await result.current.submit(); });
  expect(api.control).toHaveBeenCalledWith("agent", { text: "/help", sessionId: null });
  expect(api.createSession).not.toHaveBeenCalled(); expect(submitPrompt).not.toHaveBeenCalled();
  expect(result.current.commandFeedback?.text).toBe("Available commands"); expect(result.current.draft).toBe("");
});

test("busy conversations accept status controls while retaining ordinary prompt exclusion", async () => {
  const { result, api, submitPrompt, cancelOperation } = await setup("session", true);
  act(() => result.current.setDraft("/status"));
  expect(result.current.controlEnabled).toBe(true);
  await act(async () => { await result.current.submit(); });
  expect(api.control).toHaveBeenCalledOnce(); expect(cancelOperation).not.toHaveBeenCalled();
  act(() => result.current.setDraft("ordinary prompt"));
  await act(async () => { await result.current.submit(); });
  expect(submitPrompt).not.toHaveBeenCalled();
});

test("late control responses cannot navigate a newer selection or clear its draft", async () => {
  const { result, api } = await setup("session");
  let resolve!: (value: any) => void;
  api.control.mockImplementation(() => new Promise((done) => { resolve = done; }));
  act(() => result.current.setDraft("/new"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.submit(); });
  act(() => result.current.selectConversation("other"));
  act(() => result.current.setDraft("Keep this draft"));
  await act(async () => { resolve({ command: "new", text: "New conversation", selection: { sessionId: null } }); await pending; });
  expect(result.current.workspace?.activeConversationId).toBe("other");
  expect(result.current.draft).toBe("Keep this draft"); expect(result.current.commandFeedback).toBeNull();
});

test("control completion preserves text typed while the request was pending", async () => {
  const { result, api } = await setup();
  let resolve!: (value: any) => void;
  api.control.mockImplementation(() => new Promise((done) => { resolve = done; }));
  act(() => result.current.setDraft("/help"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.submit(); });
  act(() => result.current.setDraft("New draft"));
  await act(async () => { resolve({ command: "help", text: "Help" }); await pending; });
  expect(result.current.draft).toBe("New draft");
});
