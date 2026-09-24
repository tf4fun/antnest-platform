import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Thread } from "./Thread";
import type { Conversation as ConversationModel } from "../lib/types";

afterEach(cleanup);

const agent = { id: "agent", name: "Agent", description: "", modelLabel: "", status: "ready" as const,
  managementState: { lifecycle: "created" as const, activation: "enabled" as const,
    runtime: "available" as const } };
const history = (from: number, count: number) => Array.from({ length: count }, (_, offset) => ({
  id: `turn-${from + offset}:prompt`, role: "user" as const, content: `Question ${from + offset}`,
}));
const conversation = (messages: ConversationModel["messages"]): ConversationModel => ({
  id: "session", agentId: "agent", title: "Question", updatedAt: "now", messages,
});

test("Bridge history continuation is visible above the current conversation", async () => {
  const load = vi.fn();
  render(<Thread
    agent={{ id: "agent", name: "Agent", description: "", modelLabel: "", status: "ready",
      managementState: { lifecycle: "created", activation: "enabled", runtime: "available" } }}
    conversation={{ id: "session", agentId: "agent", title: "Question", updatedAt: "now",
      messages: [{ id: "turn:prompt", role: "user", content: "Question" }] }}
    working={false}
    hasOlderTurns
    onLoadOlder={load}
  />);
  fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
});

test("scrollable conversation has a named landmark for keyboard and screen-reader navigation", () => {
  render(<Thread agent={agent} conversation={conversation([])} working={false} />);
  const messages = screen.getByRole("region", { name: "Conversation messages" });
  expect(messages.tabIndex).toBe(0);
});

test("limited history announces a short warning while keeping long preview available", () => {
  const preview = "recent output ".repeat(1500);
  const { container, rerender } = render(<Thread agent={agent} working={false}
    conversation={conversation([])} />);
  const warning = screen.getByRole("status", { name: "History limited" });
  expect(warning.textContent).toBe("");
  rerender(<Thread agent={agent} working
    conversation={{ ...conversation([]), historyState: "view_limited",
      limitedPreview: { text: preview, truncated: true } }} />);
  expect(screen.getByRole("status", { name: "History limited" })).toBe(warning);
  expect(warning.textContent).toMatch(/history.*limited/i);
  expect(warning.textContent).not.toContain(preview);
  expect(warning.textContent!.length).toBeLessThan(200);
  expect(screen.getByRole("region", { name: "Recent output preview" }).textContent)
    .toBe(preview);
  expect(container.querySelectorAll(".conversation-turn")).toHaveLength(0);
  expect(screen.queryByText("Start with Agent")).toBeNull();
});

test("blocked history shows saved messages without offering unavailable detail or pages", async () => {
  const loadContent = vi.fn();
  const loadProcess = vi.fn();
  const loadOlder = vi.fn();
  const { container } = render(<Thread agent={agent} working={false}
    conversation={{ ...conversation([
      { id: "turn:prompt", role: "user", content: "Saved question", processCount: 2 },
      { id: "turn:answer", role: "assistant", content: "Saved partial answer",
        contentIncomplete: true },
    ]), historyState: "blocked" }}
    hasOlderTurns hasNewerTurns historyGapAfter={1}
    onLoadContent={loadContent} onLoadProcess={loadProcess} onLoadOlder={loadOlder}
    onLoadNewer={vi.fn()} />);
  expect(await screen.findByText("Saved partial answer")).toBeTruthy();
  expect(container.querySelectorAll(".conversation-turn")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Load full content" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Show process" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Load newer messages" })).toBeNull();
  expect(loadContent).not.toHaveBeenCalled();
  expect(loadProcess).not.toHaveBeenCalled();
  expect(loadOlder).not.toHaveBeenCalled();
});

test("long loaded history keeps a bounded turn window and allows older and newer browsing", async () => {
  const initial = conversation(history(0, 90));
  const { container, rerender } = render(<Thread agent={agent} conversation={initial} working={false} />);
  await waitFor(() => expect(screen.getByText("Question 89")).toBeTruthy());
  expect(container.querySelectorAll(".conversation-turn")).toHaveLength(40);
  expect(screen.queryByText("Question 0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show earlier loaded messages" }));
  await waitFor(() => expect(screen.getByText("Question 30")).toBeTruthy());
  expect(container.querySelectorAll(".conversation-turn")).toHaveLength(40);
  rerender(<Thread agent={agent} conversation={conversation(history(0, 91))} working={false} />);
  expect(screen.getByText("Question 30")).toBeTruthy();
  expect(screen.queryByText("Question 90")).toBeNull();
  const latest = screen.getByRole("button", { name: "Latest messages" });
  latest.focus();
  fireEvent.click(latest);
  await waitFor(() => expect(screen.getByText("Question 90")).toBeTruthy());
  expect(container.querySelectorAll(".conversation-turn")).toHaveLength(40);
  expect(document.activeElement).toBe(screen.getByLabelText("Conversation messages"));
});

test("a displaced history page marks its gap and can request the adjacent newer page", async () => {
  const loadNewer = vi.fn(async () => {});
  const { container } = render(<Thread agent={agent}
    conversation={conversation([...history(0, 20), ...history(80, 20)])}
    working={false} hasNewerTurns historyGapAfter={20}
    onLoadNewer={loadNewer} />);
  await waitFor(() => expect(screen.getByText("Question 99")).toBeTruthy());
  expect(container.querySelectorAll(".conversation-turn")).toHaveLength(40);
  const gap = screen.getByRole("button", { name: "Load newer messages" });
  expect(screen.getByText("Question 19").closest(".conversation-turn")?.nextElementSibling)
    .toBe(gap);
  fireEvent.click(gap);
  await waitFor(() => expect(loadNewer).toHaveBeenCalledOnce());
});

test("loading a server history page reveals its newly prepended turns within the window", async () => {
  function LoadedHistory() {
    const [messages, setMessages] = useState(history(20, 40));
    return <Thread agent={agent} conversation={conversation(messages)} working={false}
      hasOlderTurns={messages.length === 40}
      onLoadOlder={() => setMessages((current) => [...history(0, 20), ...current])} />;
  }
  const { container } = render(<LoadedHistory />);
  await waitFor(() => expect(screen.getByText("Question 59")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  await waitFor(() => expect(screen.getByText("Question 0")).toBeTruthy());
  expect(container.querySelectorAll(".conversation-turn")).toHaveLength(40);
  expect(screen.queryByText("Question 59")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show newer loaded messages" }));
  await waitFor(() => expect(screen.getByText("Question 59")).toBeTruthy());
});

test("keyboard focus returns to messages when the final older-page control disappears", async () => {
  function FinalOlderPage() {
    const [loaded, setLoaded] = useState(false);
    return <Thread agent={agent} working={false}
      conversation={conversation(loaded ? history(0, 20) : history(20, 20))}
      hasOlderTurns={!loaded} onLoadOlder={() => setLoaded(true)} />;
  }
  render(<FinalOlderPage />);
  const button = screen.getByRole("button", { name: "Load earlier messages" });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByText("Question 0")).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("Conversation messages"));
});

test("keyboard focus returns to messages when a loaded history gap closes", async () => {
  function ClosingGap() {
    const [gap, setGap] = useState(true);
    return <Thread agent={agent} working={false}
      conversation={conversation(gap
        ? [...history(0, 20), ...history(80, 20)]
        : [...history(20, 20), ...history(80, 20)])}
      hasNewerTurns historyGapAfter={gap ? 20 : undefined}
      onLoadNewer={() => setGap(false)} />;
  }
  render(<ClosingGap />);
  const button = await screen.findByRole("button", { name: "Load newer messages" });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByText("Question 20")).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Load newer messages" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("Conversation messages"));
});

test("a pending older-page load cannot move a newly selected Session away from its latest turns", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { rerender } = render(<Thread agent={agent} conversation={conversation(history(0, 40))}
    working={false} hasOlderTurns onLoadOlder={() => pending} />);
  await waitFor(() => expect(screen.getByText("Question 39")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  rerender(<Thread agent={agent} conversation={{ ...conversation(history(100, 90)), id: "other" }}
    working={false} />);
  await waitFor(() => expect(screen.getByText("Question 189")).toBeTruthy());
  expect(screen.queryByText("Question 100")).toBeNull();
  finish();
});

test("an older-page failure from the previous Session does not alert the new Session", async () => {
  let fail!: (cause: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const { rerender } = render(<Thread agent={agent} conversation={conversation(history(0, 40))}
    working={false} hasOlderTurns onLoadOlder={() => pending} />);
  await waitFor(() => expect(screen.getByText("Question 39")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  rerender(<Thread agent={agent} conversation={{ ...conversation(history(100, 10)), id: "other" }}
    working={false} />);
  await act(async () => { fail(new Error("Old Session history failed")); });
  expect(screen.queryByRole("alert")).toBeNull();
});
