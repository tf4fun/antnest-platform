import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Conversation } from "./Conversation";
import type { AgentSummary, Conversation as ConversationModel } from "../lib/types";

afterEach(cleanup);

test("unknown historical message time is omitted while a known local time remains", () => {
  const conversation: ConversationModel = {
    id: "session", agentId: "agent", title: "Conversation", updatedAt: "2026-09-01T00:00:00Z",
    messages: [
      { id: "historical", role: "assistant", content: "Historical response" },
      { id: "local", role: "user", content: "Local question", createdAt: "2026-09-10T12:00:00Z" },
    ],
  };
  const agent: AgentSummary = { id: "agent", name: "Agent", status: "ready", description: "Test", modelLabel: "Test model" };
  const { container } = render(<Conversation conversation={conversation} agent={agent} />);
  expect(container.querySelectorAll("article")).toHaveLength(2);
  expect(container.querySelector("article")?.querySelector("time")).toBeNull();
  expect(container.querySelectorAll("time")).toHaveLength(1);
  expect(container.querySelector("time")?.dateTime).toBe("2026-09-10T12:00:00Z");
});
