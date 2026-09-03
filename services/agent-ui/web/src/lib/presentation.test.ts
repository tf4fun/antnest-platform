import assert from "node:assert/strict";
import test from "node:test";
import { canSubmit, conversationTitle, conversationsForAgent, relativeTime } from "./presentation.ts";
import type { Conversation } from "./types.ts";

test("canSubmit requires content, a ready agent, and a live connection", () => {
  assert.equal(canSubmit({ text: " hello ", attachments: [], agentStatus: "ready", connected: true }), true);
  assert.equal(canSubmit({ text: "", attachments: [], agentStatus: "ready", connected: true }), false);
  assert.equal(canSubmit({ text: "hello", attachments: [], agentStatus: "busy", connected: true }), false);
  assert.equal(canSubmit({ text: "hello", attachments: [], agentStatus: "ready", connected: false }), false);
});

test("conversationTitle keeps short prompts and bounds long prompts", () => {
  assert.equal(conversationTitle("  Review   the launch plan "), "Review the launch plan");
  assert.equal(conversationTitle(""), "New conversation");
  assert.equal(conversationTitle("x".repeat(40)), `${"x".repeat(34)}...`);
});

test("conversationsForAgent filters and sorts newest first", () => {
  const conversations = [
    { id: "older", agentId: "agent-1", updatedAt: "2026-09-01T08:00:00Z" },
    { id: "other", agentId: "agent-2", updatedAt: "2026-09-02T08:00:00Z" },
    { id: "newer", agentId: "agent-1", updatedAt: "2026-09-02T08:00:00Z" },
  ] as Conversation[];
  assert.deepEqual(conversationsForAgent(conversations, "agent-1").map(({ id }) => id), ["newer", "older"]);
});

test("relativeTime returns compact stable labels", () => {
  const now = Date.parse("2026-09-02T10:00:00Z");
  assert.equal(relativeTime("2026-09-02T09:59:40Z", now), "now");
  assert.equal(relativeTime("2026-09-02T09:42:00Z", now), "18m");
  assert.equal(relativeTime("2026-09-01T08:00:00Z", now), "1d");
});
