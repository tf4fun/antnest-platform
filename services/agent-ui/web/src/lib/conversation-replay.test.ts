import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  applySessionUpdate,
  ConversationReplay,
  resetConversationReplay,
} from "./acp-state.ts";
import type { Conversation } from "./types.ts";

const previous: Conversation = {
  id: "session",
  agentId: "agent",
  title: "Existing chat",
  updatedAt: "2026-09-01T00:00:00Z",
  messages: [{ id: "previous", role: "assistant", content: "Keep on failure" }],
  plan: [{ content: "Old plan", status: "completed", priority: "low" }],
  usage: { used: 30, size: 100 },
};

test("indexed replay matches the immutable reducer across text, tool and control updates", () => {
  const updates: SessionUpdate[] = [
    {
      sessionUpdate: "user_message_chunk",
      messageId: "user",
      content: { type: "text", text: "Question" },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      messageId: "thought",
      content: { type: "text", text: "Reason" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "reply",
      content: { type: "text", text: "First" },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      rawOutput: "Early result",
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "Read",
      status: "completed",
      rawInput: { path: "/workspace/a" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "reply",
      content: { type: "text", text: " second" },
    },
    {
      sessionUpdate: "usage_update",
      used: 50,
      size: 100,
      cost: { currency: "USD", amount: 0.1 },
    },
    {
      sessionUpdate: "plan",
      entries: [{ content: "New plan", status: "pending", priority: "high" }],
    },
    { sessionUpdate: "config_option_update", configOptions: [] },
    {
      sessionUpdate: "session_info_update",
      title: "Renamed",
      updatedAt: "2026-09-02T00:00:00Z",
    },
  ];
  const candidate = new ConversationReplay(previous);
  let expected = resetConversationReplay(previous);
  for (const update of updates) {
    candidate.append(update);
    expected = applySessionUpdate(expected, update, "", "replay");
    assert.deepEqual(candidate.snapshot(), expected);
  }
  assert.equal(previous.messages[0].content, "Keep on failure");
});

test("replay snapshots own their array and message values even when folding continues", () => {
  const candidate = new ConversationReplay(previous);
  candidate.append({
    sessionUpdate: "agent_message_chunk",
    messageId: "reply",
    content: { type: "text", text: "A" },
  });
  const snapshot = candidate.snapshot();
  candidate.append({
    sessionUpdate: "agent_message_chunk",
    messageId: "reply",
    content: { type: "text", text: "B" },
  });
  candidate.append({
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    title: "Bash",
  });
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].content, "A");
  assert.equal(candidate.snapshot().messages[0].content, "AB");
});

test("anonymous replay chunks coalesce only within the current role and presentation", () => {
  const candidate = new ConversationReplay(previous);
  for (const text of ["A", "B"])
    candidate.append({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  candidate.append({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Thought" },
  });
  candidate.append({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "C" },
  });
  assert.deepEqual(
    candidate
      .snapshot()
      .messages.map((message) => [message.content, message.presentation]),
    [
      ["AB", undefined],
      ["Thought", "thought"],
      ["C", undefined],
    ],
  );
});
