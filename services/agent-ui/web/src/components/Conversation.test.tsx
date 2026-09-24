import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Conversation } from "./Conversation";
import type { AgentSummary, Conversation as ConversationModel } from "../lib/types";

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

test("active Bridge exchange can reveal process while the final answer is pending", async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "busy", description: "Test",
    modelLabel: "Test", managementState: { lifecycle: "created", activation: "enabled", runtime: "available" } };
  render(<Conversation agent={agent} onLoadProcess={load} conversation={{
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "now",
    messages: [{ id: "turn:prompt", role: "user", content: "Question", processCount: 1 }],
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  await waitFor(() => expect(load).toHaveBeenCalledWith("turn"));
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
  fireEvent.click(screen.getByRole("button", { name: "Load more process" }));
  await waitFor(() => expect(load).toHaveBeenCalledWith("turn"));
});
