import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { appendLocalUserPrompt, applySessionUpdate } from "./acp-state.ts";
import type { Conversation } from "./types.ts";

const base: Conversation = {
  id: "session-1",
  agentId: "agent-1",
  title: "New conversation",
  updatedAt: "2026-09-03T08:00:00Z",
  messages: [],
};

test("locally owns the submitted user prompt until authoritative replay", () => {
  const file = new File(["alpha"], "notes.md", { type: "text/markdown" });
  const updated = appendLocalUserPrompt(base, "  Review this  ", [{
    id: "attachment-1",
    name: file.name,
    kind: "file",
    sizeLabel: "5 B",
    mimeType: file.type,
    file,
  }], "2026-09-03T08:30:00Z");

  assert.equal(updated.updatedAt, "2026-09-03T08:30:00Z");
  assert.equal(updated.messages.length, 1);
  assert.equal(updated.messages[0]?.role, "user");
  assert.equal(updated.messages[0]?.content, "Review this");
  assert.equal(updated.messages[0]?.attachments?.[0]?.name, "notes.md");
  assert.equal(updated.messages[0]?.attachments?.[0]?.file, undefined);
});

test("ACP message chunks with one message ID append to one message", () => {
  const first = applySessionUpdate(base, {
    sessionUpdate: "agent_message_chunk",
    messageId: "message-1",
    content: { type: "text", text: "Hello" },
  } as SessionUpdate);
  const second = applySessionUpdate(first, {
    sessionUpdate: "agent_message_chunk",
    messageId: "message-1",
    content: { type: "text", text: " world" },
  } as SessionUpdate);
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0]?.content, "Hello world");
});

test("ACP Tool updates merge into one collapsed audit item", () => {
  const started = applySessionUpdate(base, {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Read project file",
    name: "read",
    status: "in_progress",
    rawInput: { path: "README.md" },
  } as SessionUpdate);
  const completed = applySessionUpdate(started, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    rawOutput: "Read 42 lines",
  } as SessionUpdate);
  assert.equal(completed.messages.length, 1);
  assert.deepEqual(completed.messages[0]?.activities?.[0], {
    id: "tool-1",
    label: "Read project file",
    tool: "read",
    status: "completed",
    summary: "Read 42 lines",
    detail: "Read 42 lines",
  });
});

test("ACP Session metadata changes title without inventing messages", () => {
  const updated = applySessionUpdate(base, {
    sessionUpdate: "session_info_update",
    title: "Quarterly planning",
    updatedAt: "2026-09-03T09:00:00Z",
  } as SessionUpdate);
  assert.equal(updated.title, "Quarterly planning");
  assert.equal(updated.updatedAt, "2026-09-03T09:00:00Z");
  assert.deepEqual(updated.messages, []);
});
