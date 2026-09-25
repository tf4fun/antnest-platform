import assert from "node:assert/strict";
import test from "node:test";
import { compactCachedConversation, mergeConversationHistory } from "./conversation-history.ts";
import type { Conversation } from "./types";

const cached: Conversation = { id: "s1", agentId: "a1", title: "Chat", updatedAt: "2026-09-10T00:00:00Z",
  messages: [{ id: "m1", role: "assistant", content: "Known answer", createdAt: "2026-09-10T00:00:00Z" }] };

test("loading and failed projections retain cached history until successful replacement", () => {
  for (const historyState of ["loading", "failed"] as const) {
    const merged = mergeConversationHistory(cached, { ...cached, messages: [], historyState });
    assert.deepEqual(merged.messages, cached.messages);
    assert.equal(merged.historyState, historyState);
  }
  assert.deepEqual(mergeConversationHistory(cached, { ...cached, messages: [] }).messages, []);
});

test("same Session ID cannot copy history across Agent boundaries", () => {
  for (const identity of [{ id: "s2" }, { agentId: "a2" }]) {
    const incoming: Conversation = { ...cached, ...identity, messages: [], historyState: "failed" };
    assert.equal(mergeConversationHistory(cached, incoming), incoming);
  }
});

test("missing cache uses only the incoming projection", () => {
  assert.equal(mergeConversationHistory(undefined, cached), cached);
});

test("leaving a completed turn releases loaded process while keeping prompt and answer", () => {
  const conversation: Conversation = { ...cached, messages: [
    { id: "done:prompt", role: "user", content: "Question", turnOutcome: "completed",
      processCount: 1, processLoaded: true },
    { id: "done:process:tool", role: "assistant", content: "private-output" },
    { id: "done:answer", role: "assistant", content: "Answer" },
    { id: "live:prompt", role: "user", content: "Still running", turnOutcome: "running",
      processCount: 1, processLoaded: true },
    { id: "live:process:tool", role: "assistant", content: "Live output" },
  ] };
  const compact = compactCachedConversation(conversation);
  assert.deepEqual(compact.messages.map((item) => item.id),
    ["done:prompt", "done:answer", "live:prompt", "live:process:tool"]);
  assert.equal(compact.messages[0]?.processLoaded, false);
  assert.equal(compact.messages[0]?.processCount, 1);
  assert.equal(conversation.messages[1]?.content, "private-output");
});
