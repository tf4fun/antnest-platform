import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { appendLocalUserPrompt, applySessionUpdate, applyConfigurationResponse } from "./acp-state.ts";
import type { Conversation } from "./types.ts";

const base: Conversation = {
  id: "session-1",
  agentId: "agent-1",
  title: "New conversation",
  updatedAt: "2026-09-03T08:00:00Z",
  messages: [],
};

test("configuration notifications replace choices without entering message history", () => {
  const configOptions = [{ id: "mode", name: "Mode", type: "select" as const,
    currentValue: "approve", options: [{value: "approve", name: "Approve"}] }];
  const updated = applySessionUpdate(base, {sessionUpdate: "config_option_update", configOptions});
  assert.deepEqual(updated.configOptions, configOptions);
  assert.deepEqual(updated.messages, []);
  const mode = applySessionUpdate(updated, {sessionUpdate: "current_mode_update", currentModeId: "chat"});
  assert.equal(mode.currentModeId, "chat");
  assert.deepEqual(mode.messages, []);
  const late = applyConfigurationResponse(updated, [], 0);
  assert.deepEqual(late.configOptions, configOptions);
  assert.deepEqual(applyConfigurationResponse(base, configOptions, 0).configOptions, configOptions);
});

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
    summary: "Completed",
    detail: "Read 42 lines",
    input: '{\n  "path": "README.md"\n}',
    output: "Read 42 lines",
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

test("structured Tool output has a status summary and retains its complete received text", () => {
  const rawOutput = { stdout: `${"line\n".repeat(3000)}FINAL_LINE`, exit_code: 0 };
  const updated = applySessionUpdate(base, {
    sessionUpdate: "tool_call", toolCallId: "large-tool", title: "Read output",
    status: "completed", rawOutput,
  } as SessionUpdate);
  const activity = updated.messages[0]?.activities?.[0];
  assert.equal(activity?.summary, "Completed");
  assert.equal(activity?.detail, JSON.stringify(rawOutput, null, 2));
  const failed = applySessionUpdate(updated, {
    sessionUpdate: "tool_call_update", toolCallId: "large-tool", status: "failed",
  } as SessionUpdate);
  assert.equal(failed.messages[0]?.activities?.[0]?.summary, "Failed");
});

test("all Tool output shapes keep status independent from full detail", () => {
  for (const rawOutput of [{}, [], "", `${"text\n".repeat(3000)}FINAL_LINE`]) {
    const updated = applySessionUpdate(base, {
      sessionUpdate: "tool_call", toolCallId: "tool-shape", title: "Tool", status: "completed", rawOutput,
    } as SessionUpdate);
    assert.equal(updated.messages[0]?.activities?.[0]?.summary, "Completed");
    assert.equal(updated.messages[0]?.activities?.[0]?.detail, typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2));
  }
});

test("mixed native history keeps audio/PDF/text in one message without Base64 text", () => {
  let conversation = base;
  for (const content of [
    { type: "text", text: "Compare these" },
    { type: "audio", data: btoa("ID3 voice"), mimeType: "audio/mpeg" },
    { type: "resource", resource: { uri: "attachment:///report.pdf", mimeType: "application/pdf", blob: btoa("%PDF-1.7") } },
    { type: "resource", resource: { uri: "attachment:///notes.md", mimeType: "text/markdown", text: "A short note" } },
  ]) {
    conversation = applySessionUpdate(conversation, { sessionUpdate: "user_message_chunk", messageId: "mixed", content } as SessionUpdate);
  }
  assert.equal(conversation.messages.length, 1);
  const message = conversation.messages[0]!;
  assert.match(message.content, /Compare these/);
  assert.match(message.content, /A short note/);
  assert.equal(message.content.includes(btoa("%PDF-1.7")), false);
  assert.deepEqual(message.attachments?.map(a => a.kind), ["audio", "file", "file"]);
  assert.equal(message.attachments?.[1]?.name, "report.pdf");
  assert.match(message.attachments?.[0]?.previewURL ?? "", /^data:audio\/mpeg;base64,/);
});

test("history does not fetch remote URIs or render executable image data", () => {
  let conversation = base;
  for (const content of [
    { type: "image", mimeType: "image/svg+xml", data: btoa("<svg></svg>") },
    { type: "resource", resource: { uri: "https://untrusted.example/file.pdf", mimeType: "application/pdf", blob: btoa("%PDF-") } },
  ]) conversation = applySessionUpdate(conversation, { sessionUpdate: "user_message_chunk", messageId: "safe", content } as SessionUpdate);
  assert.equal(conversation.messages[0]?.attachments?.length, 2);
  assert.equal(conversation.messages[0]?.attachments?.some(a => a.previewURL !== undefined), false);
});

test("replay does not invent message times or change Session activity", () => {
  let history = base;
  const updates = [
    { sessionUpdate: "user_message_chunk", messageId: "old-user", content: { type: "text", text: "Previous question" } },
    { sessionUpdate: "agent_message_chunk", messageId: "old-answer", content: { type: "text", text: "Previous answer" } },
    { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Read", status: "completed" },
  ] as SessionUpdate[];
  for (const update of updates) history = applySessionUpdate(history, update, "2026-09-10T12:00:00Z", "replay");
  assert.equal(history.updatedAt, base.updatedAt);
  assert.equal(history.messages.length, 3);
  assert(history.messages.every(message => message.createdAt === undefined));
  const title = applySessionUpdate(history, { sessionUpdate: "session_info_update", title: "Old conversation" }, "2026-09-10T12:00:00Z", "replay");
  assert.equal(title.updatedAt, base.updatedAt);
  const metadata = applySessionUpdate(title, { sessionUpdate: "session_info_update", updatedAt: "2026-09-04T10:00:00Z" }, "2026-09-10T12:00:00Z", "replay");
  assert.equal(metadata.updatedAt, "2026-09-04T10:00:00Z");
});

test("live chunks retain their first observed time without timestamping a replayed message", () => {
  const update = { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "hello" } } as SessionUpdate;
  const first = applySessionUpdate(base, update, "2026-09-10T12:00:00Z");
  const second = applySessionUpdate(first, update, "2026-09-10T12:01:00Z");
  assert.equal(second.messages[0]?.createdAt, "2026-09-10T12:00:00Z");
  assert.equal(second.updatedAt, "2026-09-10T12:01:00Z");
  const replayed = applySessionUpdate(base, update, "2026-09-10T12:00:00Z", "replay");
  const continued = applySessionUpdate(replayed, update, "2026-09-10T12:01:00Z");
  assert.equal(continued.messages[0]?.createdAt, undefined);
});
