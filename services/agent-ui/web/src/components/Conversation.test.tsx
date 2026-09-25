import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Conversation } from "./Conversation";
import type { AgentSummary, Conversation as ConversationModel } from "../lib/types";
import { WorkspaceApiError } from "../lib/workspace-api-client";
import { projectBridgeConversation, replaceBridgeProcess } from "../lib/bridge-conversation";

afterEach(() => { cleanup(); vi.useRealTimers(); });

test("unknown historical message time is omitted while a known local time remains", () => {
  const conversation: ConversationModel = {
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "2026-09-01T00:00:00Z",
    messages: [
      { id: "historical", role: "assistant", content: "Historical response" },
      { id: "local", role: "user", content: "Local question", createdAt: "2026-09-10T12:00:00Z" },
    ],
  };
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready", description: "Test", modelLabel: "Test model",
    managementState: { lifecycle: "created", activation: "enabled", runtime: "available" } };
  const { container } = render(<Conversation conversation={conversation} agent={agent} />);
  expect(container.querySelectorAll("article")).toHaveLength(2);
  expect(container.querySelector("article")?.querySelector("time")).toBeNull();
  expect(container.querySelectorAll("time")).toHaveLength(1);
  expect(container.querySelector("time")?.dateTime).toBe("2026-09-10T12:00:00Z");
});

test("a continued Bridge answer requests the exact turn content", () => {
  const load = vi.fn();
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready", description: "Test",
    modelLabel: "Test", managementState: { lifecycle: "created", activation: "enabled", runtime: "available" } };
  render(<Conversation agent={agent} settled onLoadContent={load} conversation={{
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "2026-09-23T00:00:00Z",
    messages: [
      { id: "turn-1:prompt", role: "user", content: "Question" },
      { id: "turn-1:answer", role: "assistant", content: "Partial", contentIncomplete: true },
    ],
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Load full content" }));
  expect(load).toHaveBeenCalledWith("turn-1:answer");
});

test("completed Bridge exchange discloses process count and loads it on expansion", async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready", description: "Test",
    modelLabel: "Test", managementState: { lifecycle: "created", activation: "enabled", runtime: "available" } };
  render(<Conversation agent={agent} settled onLoadProcess={load} conversation={{
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "now",
    messages: [
      { id: "turn:prompt", role: "user", content: "Question", processCount: 2 },
      { id: "turn:answer", role: "assistant", content: "Done" },
    ],
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  await waitFor(() => expect(load).toHaveBeenCalledWith("turn"));
  expect(screen.getByText("2 updates")).toBeTruthy();
});

test("active Bridge exchange opens and reads process without a user click", async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "busy", description: "Test",
    modelLabel: "Test", managementState: { lifecycle: "created", activation: "enabled", runtime: "available" } };
  render(<Conversation agent={agent} onLoadProcess={load} conversation={{
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "now",
    messages: [{ id: "turn:prompt", role: "user", content: "Question", processCount: 1,
      processVersion: 1, turnOutcome: "running" }],
  }} />);
  expect(screen.getByRole("button", { name: "Hide process" }).getAttribute("aria-expanded")).toBe("true");
  await waitFor(() => expect(load).toHaveBeenCalledWith("turn"));
  expect(load).toHaveBeenCalledTimes(1);
});

test("active process automatically follows later pages but historical process remains on demand", async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "busy",
    description: "Test", modelLabel: "Test", managementState: {
      lifecycle: "created", activation: "enabled", runtime: "available" } };
  const base = { id: "session", agentId: "agent", title: "Conversation", updatedAt: "now" };
  const prompt = { id: "turn:prompt", role: "user" as const, content: "Question",
    processCount: 2, processVersion: 1, turnOutcome: "running" as const };
  const { rerender } = render(<Conversation agent={agent} onLoadProcess={load}
    conversation={{ ...base, messages: [prompt] }} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  rerender(<Conversation agent={agent} onLoadProcess={load} conversation={{ ...base,
    messages: [{ ...prompt, processLoaded: true, processHasMore: true },
      { id: "turn:process:first", role: "assistant", content: "First", presentation: "thought" }] }} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  rerender(<Conversation agent={agent} onLoadProcess={load} conversation={{ ...base,
    messages: [{ ...prompt, processVersion: 2, processLoaded: false },
      { id: "turn:process:first", role: "assistant", content: "First",
        presentation: "thought" }] }} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  rerender(<Conversation agent={agent} settled atBottom={false} onLoadProcess={load}
    conversation={{ ...base,
    messages: [{ ...prompt, processVersion: 2, turnOutcome: "completed", processLoaded: true,
      processHasMore: false }, { id: "turn:process:first", role: "assistant",
      content: "First", presentation: "thought" }] }} />);
  expect(screen.getByRole("button", { name: "Hide process" })).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(3);
});

test("folded live process pauses reads until the reader reopens it", async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn();
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "busy",
    description: "Test", modelLabel: "Test", managementState: {
      lifecycle: "created", activation: "enabled", runtime: "available" } };
  const base = { id: "session", agentId: "agent", title: "Conversation", updatedAt: "now" };
  const prompt = { id: "turn:prompt", role: "user" as const, content: "Question",
    processCount: 1, processVersion: 1, turnOutcome: "running" as const };
  const { rerender } = render(<Conversation agent={agent} onLoadProcess={load}
    onCancelProcess={cancel} conversation={{ ...base, messages: [prompt] }} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Hide process" }));
  expect(cancel).toHaveBeenCalledWith("turn");
  rerender(<Conversation agent={agent} onLoadProcess={load} onCancelProcess={cancel}
    conversation={{ ...base, messages: [{ ...prompt, processVersion: 2 }] }} />);
  expect(load).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

test("folded Bridge process releases its retained store after the retention window", () => {
  vi.useFakeTimers();
  const unload = vi.fn();
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready", description: "Test",
    modelLabel: "Test", managementState: { lifecycle: "created", activation: "enabled", runtime: "available" } };
  render(<Conversation agent={agent} settled onUnloadProcess={unload} conversation={{
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "now",
    messages: [
      { id: "turn:prompt", role: "user", content: "Question", processCount: 1, processLoaded: true },
      { id: "turn:process:item", role: "assistant", content: "detail", presentation: "thought" },
      { id: "turn:answer", role: "assistant", content: "Done" },
    ],
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide process" }));
  act(() => vi.advanceTimersByTime(5 * 60 * 1000));
  expect(unload).toHaveBeenCalledWith("turn");
});

test("folding a Bridge process stops its request before the cache retention window", () => {
  const cancel = vi.fn();
  const unload = vi.fn();
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready",
    description: "Test", modelLabel: "Test", managementState: {
      lifecycle: "created", activation: "enabled", runtime: "available" } };
  render(<Conversation agent={agent} settled onCancelProcess={cancel}
    onUnloadProcess={unload} conversation={{ id: "session", agentId: "agent",
      title: "Conversation", updatedAt: "now", messages: [
        { id: "turn:prompt", role: "user", content: "Question", processCount: 1,
          processLoaded: true },
        { id: "turn:process:item", role: "assistant", content: "detail",
          presentation: "thought" },
        { id: "turn:answer", role: "assistant", content: "Done" },
      ] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide process" }));
  expect(cancel).toHaveBeenCalledWith("turn");
  expect(unload).not.toHaveBeenCalled();
});

test("expanded Bridge process exposes the next page without fetching it eagerly", async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready", description: "Test",
    modelLabel: "Test", managementState: { lifecycle: "created", activation: "enabled", runtime: "available" } };
  render(<Conversation agent={agent} settled onLoadProcess={load} conversation={{
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "now",
    messages: [
      { id: "turn:prompt", role: "user", content: "Question", processCount: 2,
        processLoaded: true, processHasMore: true },
      { id: "turn:process:first", role: "assistant", content: "First step", presentation: "thought" },
      { id: "turn:answer", role: "assistant", content: "Done" },
    ],
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  expect(load).not.toHaveBeenCalled();
  expect(screen.getByText("Loaded 1 of 2 updates")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more process" }));
  await waitFor(() => expect(load).toHaveBeenCalledWith("turn"));
});

test("finishing a process page does not steal focus moved during its request", async () => {
  let finish!: () => void;
  const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready",
    description: "Test", modelLabel: "Test", managementState: {
      lifecycle: "created", activation: "enabled", runtime: "available" } };
  const base = { id: "session", agentId: "agent", title: "Conversation", updatedAt: "now" };
  const prompt = { id: "turn:prompt", role: "user" as const, content: "Question",
    processCount: 2, processLoaded: true, processHasMore: true };
  const first = { id: "turn:process:first", role: "assistant" as const,
    content: "First step", presentation: "thought" as const };
  const { rerender } = render(<Conversation agent={agent} settled onLoadProcess={load}
    conversation={{ ...base, messages: [prompt, first] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  const next = screen.getByRole("button", { name: "Load more process" });
  next.focus();
  fireEvent.click(next, { detail: 0 });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  const other = document.createElement("button");
  document.body.append(other);
  try {
    other.focus();
    rerender(<Conversation agent={agent} settled onLoadProcess={load}
      conversation={{ ...base, messages: [{ ...prompt, processHasMore: false }, first,
        { id: "turn:process:second", role: "assistant", content: "Second step",
          presentation: "thought" }] }} />);
    await act(async () => finish());
    expect(document.activeElement).toBe(other);
  } finally {
    other.remove();
  }
});

test("a process page boundary preserves an open thought and the agent's interim reply order", () => {
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready",
    description: "Test", modelLabel: "Test", managementState: {
      lifecycle: "created", activation: "enabled", runtime: "available" } };
  const projection = projectBridgeConversation({ sessionId: "session", bridgeEpoch: "epoch",
    incarnation: "incarnation", historyState: "ready", olderTurnsCursor: null,
    turns: [{ turnId: "turn", outcome: "completed", prompt: [{ type: "text", text: "Question" }],
      finalResponse: [{ type: "text", text: "Final answer" }], contentCursor: null, contentSection: null,
      processVersion: 11, processCount: 11 }] }, "agent", "session", "now");
  const thought = (index: number) => ({ id: `thought-${index}`, kind: "thought" as const,
    summary: "Thought", status: "completed" as const,
    content: [{ type: "text" as const, text: `Reason ${index}` }], contentCursor: null });
  const first = Array.from({ length: 10 }, (_, index) => thought(index));
  const firstPage = replaceBridgeProcess(projection.conversation, "turn", first, true);
  const { container, rerender } = render(<Conversation agent={agent} settled
    conversation={firstPage} onLoadProcess={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  const openThought = container.querySelectorAll<HTMLDetailsElement>(".thought-process")[9]!;
  fireEvent.click(openThought.querySelector("summary")!);
  expect(openThought.open).toBe(true);
  const secondPage = replaceBridgeProcess(projection.conversation, "turn", [...first,
    { id: "interim", kind: "notice", summary: "Intermediate response",
      status: "completed", content: [{ type: "text", text: "Interim answer" }],
      contentCursor: null }], false);
  rerender(<Conversation agent={agent} settled conversation={secondPage} onLoadProcess={vi.fn()} />);
  expect(container.querySelectorAll(".thought-process")[9]).toBe(openThought);
  expect(openThought.open).toBe(true);
  const process = container.querySelector(".turn-process-content")!;
  expect(process.textContent).toContain("Interim answer");
  expect(process.textContent).not.toContain("Final answer");
  expect(container.textContent!.indexOf("Interim answer")).toBeLessThan(
    container.textContent!.indexOf("Final answer"));
  expect(process.querySelector(".message-system")).toBeNull();
});

test("first process page timeout offers a visible retry without folding", async () => {
  const load = vi.fn()
    .mockRejectedValueOnce(new WorkspaceApiError("Timed out", undefined,
      "workspace_request_timeout", "retry_read"))
    .mockResolvedValueOnce(undefined);
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready",
    description: "Test", modelLabel: "Test", managementState: {
      lifecycle: "created", activation: "enabled", runtime: "available" } };
  render(<Conversation agent={agent} settled onLoadProcess={load} conversation={{
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "now",
    messages: [{ id: "turn:prompt", role: "user", content: "Question", processCount: 2 },
      { id: "turn:answer", role: "assistant", content: "Done" }],
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/timed out/i));
  fireEvent.click(screen.getByRole("button", { name: "Retry process" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

test("process pagination announces busy state while retaining loaded entries", async () => {
  let finish!: () => void;
  const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready",
    description: "Test", modelLabel: "Test", managementState: {
      lifecycle: "created", activation: "enabled", runtime: "available" } };
  const { container } = render(<Conversation agent={agent} settled onLoadProcess={load}
    conversation={{ id: "session", agentId: "agent", title: "Conversation", updatedAt: "now",
      messages: [{ id: "turn:prompt", role: "user", content: "Question", processCount: 2,
        processLoaded: true, processHasMore: true },
      { id: "turn:process:first", role: "assistant", content: "First step",
        presentation: "thought" }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  fireEvent.click(screen.getByRole("button", { name: "Load more process" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(container.querySelector(".turn-process-content")?.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByText("First step")).toBeTruthy();
  finish();
  await waitFor(() => expect(container.querySelector(".turn-process-content")?.getAttribute("aria-busy")).toBe("false"));
});
