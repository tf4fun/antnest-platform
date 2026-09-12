import assert from "node:assert/strict";
import test from "node:test";
import { mergeConversationHistory } from "./conversation-history.ts";
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
