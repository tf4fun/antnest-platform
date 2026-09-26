import assert from "node:assert/strict";
import test from "node:test";
import { projectBridgeConversation, replaceBridgeProcess, replaceBridgeTurnContent } from "./bridge-conversation.ts";
import { initialBridgeContent } from "./bridge-content.ts";

test("Session projection carries only the selected catalog and rejects malformed commands", () => {
  const view = { sessionId: "session", bridgeEpoch: "epoch", historyState: "ready",
    turns: [], olderTurnsCursor: null, availableCommands: [
      { name: "help", description: "Help" },
      { name: "plan", description: "Plan", input: { hint: "task" } },
    ] };
  const read = (raw: unknown) => projectBridgeConversation(raw, "agent", "session", "now");
  assert.deepEqual(read(view).conversation.availableCommands, view.availableCommands);
  assert.deepEqual(read({ ...view, availableCommands: [] }).conversation.availableCommands, []);
  for (const availableCommands of ["help", [{ name: "/help", description: "Help" }],
    [{ name: "help now", description: "Help" }], [view.availableCommands[0], view.availableCommands[0]]])
    assert.throws(() => read({ ...view, availableCommands }));
});

test("Session projection uses ACP metadata instead of deriving title or local time", () => {
  const view = {
    sessionId: "session-1", bridgeEpoch: "epoch-1", historyState: "ready",
    title: "Server title", updatedAt: "2026-09-24T02:00:00Z",
    turns: [{ turnId: "turn-1", outcome: "completed",
      prompt: [{ type: "text", text: "Different first prompt" }], finalResponse: [],
      contentCursor: null, contentSection: null, processVersion: 0, processCount: 0 }],
    olderTurnsCursor: null,
  };
  const projected = projectBridgeConversation(view, "agent-1", "session-1", "local-time");
  assert.equal(projected.conversation.title, "Server title");
  assert.equal(projected.conversation.updatedAt, "2026-09-24T02:00:00Z");
});

test("Bridge turn preview keeps incomplete content explicit and preserves stable turn identity", () => {
  const projected = projectBridgeConversation({
    sessionId: "session-1", bridgeEpoch: "epoch-1", historyState: "ready",
    turns: [{ turnId: "turn-1", outcome: "completed",
      prompt: [{ type: "text", text: "Question" }],
      finalResponse: [{ type: "text", text: "Partial answer" }],
      contentCursor: "next-content", contentSection: "finalResponse",
      processVersion: 2, processCount: 3 }],
    olderTurnsCursor: "older", configOptions: [], usage: null,
  }, "agent-1", "session-1", "2026-09-23T00:00:00.000Z");
  assert.deepEqual(projected.conversation.messages.map(({ id, role, content, contentIncomplete }) =>
    ({ id, role, content, contentIncomplete })), [
    { id: "turn-1:prompt", role: "user", content: "Question", contentIncomplete: false },
    { id: "turn-1:answer", role: "assistant", content: "Partial answer", contentIncomplete: true },
  ]);
  assert.equal(projected.turns.get("turn-1")?.cursor, "next-content");
  assert.equal(projected.conversation.messages[0]?.processVersion, 2);
  assert.equal(projected.olderTurnsCursor, "older");
});

test("prompt continuation leaves no phantom incomplete answer", () => {
  const projected = projectBridgeConversation({ sessionId: "session", bridgeEpoch: "epoch",
    historyState: "ready", turns: [{ turnId: "turn", outcome: "completed",
      prompt: [], finalResponse: [], contentCursor: "next-prompt",
      contentSection: "prompt", processVersion: 0, processCount: 0 }],
    olderTurnsCursor: null }, "agent", "session", "now");
  assert.deepEqual(projected.conversation.messages.map((message) =>
    [message.id, message.contentIncomplete]), [["turn:prompt", true]]);
});

test("failed Bridge turn retains its authoritative outcome", () => {
  const projected = projectBridgeConversation({
    sessionId: "session-1", bridgeEpoch: "epoch-1", historyState: "ready",
    turns: [{ turnId: "turn-1", outcome: "failed",
      prompt: [{ type: "text", text: "Question" }], finalResponse: [],
      contentCursor: null, contentSection: null, processVersion: 0, processCount: 0 }],
    olderTurnsCursor: null, configOptions: [], usage: null,
  }, "agent-1", "session-1", "2026-09-23T00:00:00.000Z");
  assert.equal(projected.conversation.messages[0]?.turnOutcome, "failed");
});

test("real Bridge process keeps plan progress and tool sections inside their cards", () => {
  const projected = projectBridgeConversation({ sessionId: "session", bridgeEpoch: "epoch",
    historyState: "ready", turns: [{ turnId: "turn", outcome: "completed",
      prompt: [{ type: "text", text: "Question" }], finalResponse: [],
      contentCursor: null, contentSection: null, processVersion: 1, processCount: 2 }],
    olderTurnsCursor: null }, "agent", "session", "now");
  const next = replaceBridgeProcess(projected.conversation, "turn", [
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
  const plan = next.messages.find((item) => item.id === "turn:process:plan");
  const tool = next.messages.find((item) => item.id === "turn:process:tool");
  assert.equal(plan?.presentation, "plan");
  assert.deepEqual(plan?.planEntries?.map((entry) => entry.status),
    ["completed", "in_progress"]);
  assert.equal(tool?.content, "");
  assert.equal(tool?.activities?.[0]?.input, '{"path":"notes.txt"}');
  assert.equal(tool?.activities?.[0]?.output, '{"lines":2}');
  assert.equal(tool?.activities?.[0]?.detail, "File contents");
  assert.equal(tool?.activities?.[0]?.status, "pending");
});

test("completed Bridge content projects all attachment blocks in order", () => {
  const projected = projectBridgeConversation({
    sessionId: "session-1", bridgeEpoch: "epoch-1", historyState: "ready",
    turns: [{ turnId: "turn-1", outcome: "completed",
      prompt: [{ type: "text", text: "Question" }],
      finalResponse: [{ type: "text", text: "A" }, { type: "resource_link", name: "source", uri: "https://example.test" },
        { type: "text", text: "B" }],
      contentCursor: null, contentSection: null, processVersion: 0, processCount: 0 }],
    olderTurnsCursor: null, configOptions: [], usage: null,
  }, "agent-1", "session-1", "2026-09-23T00:00:00.000Z");
  assert.equal(projected.conversation.messages[1]?.content, "A\n[source]\nB");
  assert.equal(projected.conversation.messages[1]?.contentIncomplete, false);
});

test("Bridge Session View cannot project another Session or duplicate turns", () => {
  const base = { sessionId: "session-1", bridgeEpoch: "epoch-1", historyState: "ready",
    turns: [], olderTurnsCursor: null, configOptions: [], usage: null };
  assert.throws(() => projectBridgeConversation(base, "agent-1", "session-2", "now"), /Session scope/u);
  const turn = { turnId: "same", outcome: "completed", prompt: [], finalResponse: [],
    contentCursor: null, contentSection: null, processVersion: 0, processCount: 0 };
  assert.throws(() => projectBridgeConversation({ ...base, turns: [turn, turn] },
    "agent-1", "session-1", "now"), /duplicate turn/u);
});

test("loaded turn content atomically replaces both previews without touching other turns", () => {
  const original = {
    id: "session", agentId: "agent", title: "Question", updatedAt: "now",
    messages: [
      { id: "turn-1:prompt", role: "user" as const, content: "Preview", contentIncomplete: true },
      { id: "turn-1:answer", role: "assistant" as const, content: "Partial", contentIncomplete: true },
      { id: "turn-2:prompt", role: "user" as const, content: "Later" },
    ],
  };
  const state = initialBridgeContent([{ type: "text", text: "Full question" }],
    [{ type: "text", text: "Full answer" }], null);
  const next = replaceBridgeTurnContent(original, "turn-1", state);
  assert.equal(next.messages[0]?.content, "Full question");
  assert.equal(next.messages[1]?.content, "Full answer");
  assert.equal(next.messages[1]?.contentIncomplete, false);
  assert.equal(next.messages[2], original.messages[2]);
  assert.equal(original.messages[1]?.content, "Partial");
});

test("Bridge Session View projects configuration and usage into existing controls", () => {
  const projected = projectBridgeConversation({
    sessionId: "session", bridgeEpoch: "epoch", historyState: "ready", turns: [],
    olderTurnsCursor: null,
    configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "a",
      options: [{ value: "a", name: "A" }] }],
    usage: { used: 5, size: 100, cost: { amount: 0.1, currency: "USD" } },
  }, "agent", "session", "now");
  assert.equal(projected.conversation.configOptions?.[0]?.id, "model");
  assert.deepEqual(projected.conversation.usage, { used: 5, size: 100,
    cost: { amount: 0.1, currency: "USD" } });
});

test("Bridge View rejects the removed lossy history state", () => {
  assert.throws(() => projectBridgeConversation({
    sessionId: "session", bridgeEpoch: "epoch", historyState: "view_limited",
    turns: [], olderTurnsCursor: null, historyToken: null, outputWatermark: 1,
    limitedPreview: { text: "partial", truncated: true },
  }, "agent", "session", "now"), /Invalid Bridge Session View/u);
});

test("blocked Bridge View keeps sealed turns without write or pagination tokens", () => {
  const base = { ...{
    sessionId: "session", bridgeEpoch: "epoch", historyState: "blocked",
    turns: [{ turnId: "turn", outcome: "completed", prompt: [{ type: "text", text: "Question" }],
      finalResponse: [{ type: "text", text: "Saved answer" }], contentCursor: null, contentSection: null,
      processVersion: 0, processCount: 0 }],
    olderTurnsCursor: null, historyToken: null, configurationToken: null,
    outputWatermark: 2, configOptions: [], usage: null,
  } };
  const projected = projectBridgeConversation(base, "agent", "session", "now");
  assert.equal(projected.conversation.historyState, "blocked");
  assert.equal(projected.conversation.messages[1]?.content, "Saved answer");
  assert.equal(projected.olderTurnsCursor, null);
  for (const invalid of [{ historyToken: "write" }, { configurationToken: "configure" },
    { olderTurnsCursor: "older" }])
    assert.throws(() => projectBridgeConversation({ ...base, ...invalid },
      "agent", "session", "now"), /Invalid Bridge Session View/u);
});
