import assert from "node:assert/strict";
import test from "node:test";
import { projectBridgeConversation, replaceBridgeTurnContent } from "./bridge-conversation.ts";
import { initialBridgeContent } from "./bridge-content.ts";

test("Session projection uses ACP metadata instead of deriving title or local time", () => {
  const view = {
    sessionId: "session-1", bridgeEpoch: "epoch-1", historyState: "ready",
    title: "Server title", updatedAt: "2026-09-24T02:00:00Z",
    turns: [{ turnId: "turn-1", outcome: "completed",
      prompt: [{ type: "text", text: "Different first prompt" }], finalResponse: [],
      contentCursor: null, processVersion: 0, processCount: 0 }],
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
      contentCursor: "next-content", processVersion: 2, processCount: 3 }],
    olderTurnsCursor: "older", configOptions: [], usage: null,
  }, "agent-1", "session-1", "2026-09-23T00:00:00.000Z");
  assert.deepEqual(projected.conversation.messages.map(({ id, role, content, contentIncomplete }) =>
    ({ id, role, content, contentIncomplete })), [
    { id: "turn-1:prompt", role: "user", content: "Question", contentIncomplete: true },
    { id: "turn-1:answer", role: "assistant", content: "Partial answer", contentIncomplete: true },
  ]);
  assert.equal(projected.turns.get("turn-1")?.cursor, "next-content");
  assert.equal(projected.olderTurnsCursor, "older");
});

test("failed Bridge turn retains its authoritative outcome", () => {
  const projected = projectBridgeConversation({
    sessionId: "session-1", bridgeEpoch: "epoch-1", historyState: "ready",
    turns: [{ turnId: "turn-1", outcome: "failed",
      prompt: [{ type: "text", text: "Question" }], finalResponse: [],
      contentCursor: null, processVersion: 0, processCount: 0 }],
    olderTurnsCursor: null, configOptions: [], usage: null,
  }, "agent-1", "session-1", "2026-09-23T00:00:00.000Z");
  assert.equal(projected.conversation.messages[0]?.turnOutcome, "failed");
});

test("completed Bridge content projects all attachment blocks in order", () => {
  const projected = projectBridgeConversation({
    sessionId: "session-1", bridgeEpoch: "epoch-1", historyState: "ready",
    turns: [{ turnId: "turn-1", outcome: "completed",
      prompt: [{ type: "text", text: "Question" }],
      finalResponse: [{ type: "text", text: "A" }, { type: "resource_link", name: "source", uri: "https://example.test" },
        { type: "text", text: "B" }],
      contentCursor: null, processVersion: 0, processCount: 0 }],
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
    contentCursor: null, processVersion: 0, processCount: 0 };
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

test("limited Bridge View exposes only an incomplete preview, never a turn", () => {
  const projected = projectBridgeConversation({
    sessionId: "session", bridgeEpoch: "epoch", incarnation: "incarnation",
    historyState: "view_limited", turns: [], olderTurnsCursor: null,
    historyToken: null, outputWatermark: 42,
    limitedPreview: { text: "recent output", truncated: true },
    configOptions: [], usage: { used: 5, size: 100 },
  }, "agent", "session", "now");
  assert.equal(projected.conversation.historyState, "view_limited");
  assert.deepEqual(projected.conversation.limitedPreview,
    { text: "recent output", truncated: true });
  assert.deepEqual(projected.conversation.messages, []);
  assert.equal(projected.outputWatermark, 42);
  assert.equal(projected.olderTurnsCursor, null);
  assert.equal(projected.turns.size, 0);
});

test("limited Bridge View rejects a full turn, token, or unbounded preview", () => {
  const base = { sessionId: "session", bridgeEpoch: "epoch", historyState: "view_limited",
    turns: [], olderTurnsCursor: null, historyToken: null, outputWatermark: 1,
    limitedPreview: { text: "partial", truncated: true } };
  for (const invalid of [
    { turns: [{ turnId: "turn" }] }, { historyToken: "token" },
    { limitedPreview: { text: "x".repeat(4097), truncated: true } },
    { limitedPreview: { text: "complete", truncated: false } },
  ]) assert.throws(() => projectBridgeConversation({ ...base, ...invalid },
    "agent", "session", "now"), /Invalid Bridge Session View/u);
});

test("blocked Bridge View keeps sealed turns without write or pagination tokens", () => {
  const base = { ...{
    sessionId: "session", bridgeEpoch: "epoch", historyState: "blocked",
    turns: [{ turnId: "turn", outcome: "completed", prompt: [{ type: "text", text: "Question" }],
      finalResponse: [{ type: "text", text: "Saved answer" }], contentCursor: null,
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
