import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageView } from "./MessageView";
import { WorkspaceApiError } from "../lib/workspace-api-client";
import { projectBridgeConversation, replaceBridgeProcess } from "../lib/bridge-conversation";

describe("Bridge content preview", () => {
  afterEach(cleanup);
  it("labels an incomplete answer and does not offer copying its partial text", () => {
    render(<MessageView message={{ id: "answer", role: "assistant", content: "Partial",
      contentIncomplete: true }} answer />);
    expect(screen.getByText("More content available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy response" })).toBeNull();
  });

  it("loads the full block sequence only when requested", () => {
    const load = vi.fn();
    render(<MessageView message={{ id: "turn-1:answer", role: "assistant", content: "Partial",
      contentIncomplete: true }} answer onLoadContent={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Load full content" }));
    expect(load).toHaveBeenCalledWith("turn-1:answer");
  });

  it("shows full-content loading, timeout and an explicit retry", async () => {
    let rejectFirst!: (cause: unknown) => void;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(undefined);
    render(<MessageView message={{ id: "turn-1:answer", role: "assistant",
      content: "Partial", contentIncomplete: true }} answer onLoadContent={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Load full content" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Loading full content" })
        .hasAttribute("disabled")).toBe(true);
    });
    rejectFirst(new WorkspaceApiError("Timed out", undefined,
      "workspace_request_timeout", "retry_read"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/timed out/i));
    fireEvent.click(screen.getByRole("button", { name: "Retry full content" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("does not steal focus moved elsewhere while full content is loading", async () => {
    let finish!: () => void;
    const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const partial = { id: "turn-1:answer", role: "assistant" as const,
      content: "Partial", contentIncomplete: true };
    const { rerender } = render(<MessageView message={partial} answer onLoadContent={load} />);
    const action = screen.getByRole("button", { name: "Load full content" });
    action.focus();
    fireEvent.click(action, { detail: 0 });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const other = document.createElement("button");
    document.body.append(other);
    try {
      other.focus();
      rerender(<MessageView message={{ ...partial, content: "Complete",
        contentIncomplete: false }} answer onLoadContent={load} />);
      await act(async () => finish());
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });

  it("renders real Bridge Plan progress and tool sections in their own cards", () => {
    const projected = projectBridgeConversation({ sessionId: "session", bridgeEpoch: "epoch",
      historyState: "ready", turns: [{ turnId: "turn", outcome: "completed",
        prompt: [{ type: "text", text: "Question" }], finalResponse: [],
        contentCursor: null, contentSection: null, processVersion: 1, processCount: 2 }],
      olderTurnsCursor: null }, "agent", "session", "now");
    const conversation = replaceBridgeProcess(projected.conversation, "turn", [
      { id: "plan", kind: "plan", summary: "Plan", status: "completed",
        content: [{ type: "text", text: JSON.stringify([
          { content: "Read file", priority: "medium", status: "completed" },
          { content: "Summarize", priority: "high", status: "in_progress" },
        ]) }], contentCursor: null },
      { id: "tool", kind: "tool", summary: "Read", status: "pending",
        toolSections: { inputIndex: 0, outputIndex: 1, detailStartIndex: 2 },
        content: [{ type: "text", text: 'Input: {"path":"notes.txt"}' },
          { type: "text", text: 'Output: {"lines":2}' },
          { type: "text", text: "File contents" }], contentCursor: null },
    ]);
    const { container } = render(<>{conversation.messages.slice(1).map((message) =>
      <MessageView key={message.id} message={message} />)}</>);
    const plan = container.querySelector(".plan-card");
    expect(plan?.textContent).toContain("1/2");
    expect(plan?.textContent).toContain("Read file");
    expect(plan?.textContent).toContain("Summarize");
    const tool = container.querySelector(".tool-activity");
    expect(tool?.textContent).toContain("Pending");
    expect(tool?.textContent).toContain('{"path":"notes.txt"}');
    expect(tool?.textContent).toContain('{"lines":2}');
    expect(tool?.textContent).toContain("File contents");
    expect(container.querySelector(".thought-process")).toBeNull();
  });
});
