import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AgentSummary,
  Conversation as ConversationModel,
} from "../lib/types";
import { Conversation } from "./Conversation";

afterEach(cleanup);
const agent: AgentSummary = {
  id: "agent",
  name: "Research Partner",
  status: "ready",
  managementState: {
    lifecycle: "created",
    activation: "enabled",
    runtime: "available",
  },
  description: "",
  modelLabel: "",
};
const conversation: ConversationModel = {
  id: "session",
  agentId: "agent",
  title: "Report",
  updatedAt: "2026-09-15T00:00:00Z",
  messages: [
    { id: "question", role: "user", content: "Review my report" },
    { id: "progress", role: "assistant", content: "Reading the report now." },
    {
      id: "thought",
      role: "assistant",
      presentation: "thought",
      content: "Compare the numbers",
    },
    {
      id: "tools",
      role: "assistant",
      content: "",
      activities: [
        {
          id: "read",
          label: "Read report",
          tool: "read",
          status: "completed",
          summary: "Completed",
          input: "notes.md",
          output: "Revenue 12%",
        },
      ],
    },
    {
      id: "answer",
      role: "assistant",
      content: "Revenue increased by **12%**.",
    },
  ],
};

test("live process stays visible then folds around the answer when settled", () => {
  const { container, rerender } = render(
    <Conversation agent={agent} conversation={conversation} settled={false} />,
  );
  expect(
    screen.getByText("Reading the report now.").closest("[hidden]"),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /Show process/ })).toBeNull();
  rerender(<Conversation agent={agent} conversation={conversation} settled />);
  const toggle = screen.getByRole("button", { name: /Show process/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(
    document
      .getElementById(toggle.getAttribute("aria-controls")!)
      ?.hasAttribute("hidden"),
  ).toBe(true);
  expect(
    screen.getByText("Reading the report now.").closest("[hidden]"),
  ).not.toBeNull();
  expect(screen.getByText("12%").closest("[hidden]")).toBeNull();
  expect(screen.getByText("Review my report").closest("[hidden]")).toBeNull();
  expect(container.querySelectorAll(".turn-agent-label")).toHaveLength(1);
  expect(container.querySelector(".assistant-avatar")).toBeNull();
});

test("manual expansion pauses scrolling and survives updates and the next question", () => {
  const pause = vi.fn();
  const { container, rerender } = render(
    <Conversation
      agent={agent}
      conversation={conversation}
      settled
      onProcessToggle={pause}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Show process/ }));
  expect(pause).toHaveBeenCalledOnce();
  const tool = container.querySelector<HTMLDetailsElement>(".tool-activity")!;
  expect(tool.open).toBe(false);
  fireEvent.click(tool.querySelector("summary")!);
  expect(tool.open).toBe(true);
  rerender(
    <Conversation
      agent={agent}
      conversation={{
        ...conversation,
        messages: [
          ...conversation.messages,
          { id: "next", role: "user", content: "Next question" },
        ],
      }}
      settled={false}
      onProcessToggle={pause}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: /Hide process/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(container.querySelector(".tool-activity")).toBe(tool);
  expect(tool.open).toBe(true);
  expect(
    screen
      .getAllByRole("heading", { name: /Exchange \d+/ })
      .map((item) => item.textContent),
  ).toEqual(["Exchange 1", "Exchange 2"]);
});

test("auto folding waits until a reader returns to the bottom", () => {
  const { rerender } = render(
    <Conversation
      agent={agent}
      conversation={conversation}
      settled={false}
      atBottom={false}
    />,
  );
  rerender(
    <Conversation
      agent={agent}
      conversation={conversation}
      settled
      atBottom={false}
    />,
  );
  expect(screen.queryByRole("button", { name: /Show process/ })).toBeNull();
  expect(
    screen.getByText("Reading the report now.").closest("[hidden]"),
  ).toBeNull();
  rerender(
    <Conversation agent={agent} conversation={conversation} settled atBottom />,
  );
  expect(screen.getByRole("button", { name: /Show process/ })).toBeTruthy();
});

test("settled history folds immediately and failures remain visible without a final answer", () => {
  const failed: ConversationModel = {
    ...conversation,
    messages: [
      conversation.messages[0],
      {
        id: "failed-tool",
        role: "assistant",
        content: "",
        activities: [
          {
            id: "failed",
            label: "Read report",
            tool: "read",
            status: "failed",
            summary: "Failed",
            output: "Permission denied",
          },
        ],
      },
      { id: "notice", role: "system", content: "Connection lost" },
    ],
  };
  render(<Conversation agent={agent} conversation={failed} settled />);
  expect(
    screen.getByRole("button", { name: /Show process/ }).textContent,
  ).toContain("1 failed");
  expect(screen.getByText("Connection lost").closest("[hidden]")).toBeNull();
  expect(screen.queryByLabelText("Copy response")).toBeNull();
});

test("an answer copy excludes tool output and intermediate text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<Conversation agent={agent} conversation={conversation} settled />);
  fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
  expect(writeText).toHaveBeenCalledWith("Revenue increased by **12%**.");
});

test("ordinary single-response chats have no empty process disclosure", () => {
  render(
    <Conversation
      agent={agent}
      conversation={{
        ...conversation,
        messages: [conversation.messages[0], conversation.messages[4]],
      }}
      settled
    />,
  );
  expect(screen.queryByRole("button", { name: /process/ })).toBeNull();
  expect(screen.getByText("12%")).toBeTruthy();
});

test("live system notices keep their timeline position and are never hidden by process folding", () => {
  const messages = [...conversation.messages];
  messages.splice(2, 0, {
    id: "system",
    role: "system",
    content: "Runtime changed",
  });
  const { container, rerender } = render(
    <Conversation
      agent={agent}
      conversation={{ ...conversation, messages }}
      settled={false}
    />,
  );
  const entries = [...container.querySelectorAll("article")].map(
    (element) => element.textContent,
  );
  expect(entries[2]).toContain("Runtime changed");
  expect(entries[3]).toContain("Compare the numbers");
  rerender(
    <Conversation
      agent={agent}
      conversation={{ ...conversation, messages }}
      settled
    />,
  );
  expect(screen.getAllByText("Runtime changed")).toHaveLength(1);
  expect(screen.getByText("Runtime changed").closest("[hidden]")).toBeNull();
});

test("expanded tool details survive live updates and completion, but another Session starts folded", () => {
  const { container, rerender } = render(
    <Conversation agent={agent} conversation={conversation} settled={false} />,
  );
  const tool = container.querySelector<HTMLDetailsElement>(".tool-activity")!;
  fireEvent.click(tool.querySelector("summary")!);
  rerender(<Conversation agent={agent} conversation={conversation} settled />);
  fireEvent.click(screen.getByRole("button", { name: "Show process" }));
  expect(container.querySelector(".tool-activity")).toBe(tool);
  expect(tool.open).toBe(true);
  rerender(
    <Conversation
      agent={agent}
      conversation={{ ...conversation, id: "other-session" }}
      settled
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Show process" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    container.querySelector<HTMLDetailsElement>(".tool-activity")!.open,
  ).toBe(false);
});
